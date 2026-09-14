/**
 * Log files followed line by line. pg_ctl hands a server's output to a file rather than to a pipe
 * Paddock holds, so the only way to see it is to read what gets appended.
 *
 * Polled rather than watched: fs.watch misses appends on some filesystems and reports renames
 * differently on every platform, and one stat a second costs nothing. Following starts at the end
 * of the file — what was written before is in the file itself, and reading it again on every Paddock
 * start would store it twice — except for a file that does not exist yet, which is read from its
 * first byte once the server creates it.
 */
import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { createLineSplitter } from '../line-splitter.js';

const POLL_MS = 1_000;
/** One poll's worth, so a server that logged a burst while nobody polled cannot stall the loop. */
const MAX_READ_BYTES = 1_048_576;

/** @type {Map<string, object>} one follower per key */
const followers = new Map();

/**
 * Follow `file` under `key`, replacing whatever that key followed before. Resolves once the starting
 * offset is known, so a caller about to make the file grow — a server start — loses none of it.
 * @param {string} key
 * @param {string} file
 * @param {(line: string) => void} onLine
 */
export function follow(key, file, onLine) {
  const current = followers.get(key);
  if (current?.file === file) return current.started;
  unfollow(key);
  const follower = {
    key,
    file,
    onLine,
    offset: null,
    reading: false,
    splitter: createLineSplitter(),
    // A multi-byte character can straddle the end of one read and the start of the next.
    decoder: new StringDecoder('utf8'),
  };
  followers.set(key, follower);
  follower.timer = setInterval(() => poll(follower), POLL_MS);
  follower.timer.unref();
  follower.started = poll(follower);
  return follower.started;
}

/** @param {string} key */
export function unfollow(key) {
  const follower = followers.get(key);
  if (!follower) return;
  clearInterval(follower.timer);
  followers.delete(key);
}

export function unfollowAll() {
  for (const key of [...followers.keys()]) unfollow(key);
}

/** One read at a time per file: an interval tick that lands mid-read would read the same bytes. */
async function poll(follower) {
  if (follower.reading) return;
  follower.reading = true;
  try {
    await readAppended(follower);
  } catch {
    // Unreadable this tick (rotated mid-read, permissions changed) — the next tick tries again.
  } finally {
    follower.reading = false;
  }
}

async function readAppended(follower) {
  const size = await fs.stat(follower.file).then((stats) => stats.size, () => null);
  if (follower.offset === null) {
    follower.offset = size ?? 0;
    return;
  }
  if (size === null || size === follower.offset) return;
  // Shorter than what was already read: truncated or replaced, so everything in it is new.
  if (size < follower.offset) follower.offset = 0;
  const chunk = await readRange(follower.file, follower.offset, Math.min(size - follower.offset, MAX_READ_BYTES));
  follower.offset += chunk.length;
  // Unfollowed while the read was in flight: its lines belong to nothing any more.
  if (followers.get(follower.key) !== follower) return;
  for (const line of follower.splitter.push(follower.decoder.write(chunk))) follower.onLine(line);
}

/** @returns {Promise<Buffer>} what was actually there, which a concurrent truncate can make shorter */
async function readRange(file, position, length) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
