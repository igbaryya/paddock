/**
 * An append-only JSONL file with one rotation, and a backwards tail reader for cold starts.
 *
 * Shared by the process logs and the MCP tool-call audit: both keep a bounded ring in memory and
 * this file on disk, and both need the same guarantees — every write goes through one queue per
 * file so an append, a rotation and the shutdown flush can never interleave, and a failing disk
 * disables that one file instead of taking the manager down with it.
 */
import fs from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const TAIL_CHUNK_BYTES = 65_536;
const TAIL_MAX_SCAN_BYTES = 262_144;

const noop = () => {};

/**
 * @typedef {{file:string, maxBytes:number, stream:fs.WriteStream|null, bytes:number,
 *            queue:Promise<void>, disabled:boolean}} Sink
 */

/**
 * @param {string} file must end in `.jsonl`; the rotated copy is `<name>.1.jsonl`
 * @param {number} maxBytes size at which the file is rotated
 * @returns {Sink}
 */
export const createSink = (file, maxBytes) => ({
  file, maxBytes, stream: null, bytes: 0, queue: Promise.resolve(), disabled: false,
});

/**
 * Queue one line. Never throws: a write that fails disables the sink and says so once.
 * @param {Sink} sink
 * @param {string} line including its trailing newline
 */
export function appendLine(sink, line) {
  if (sink.disabled) return;
  enqueue(sink, () => writeLine(sink, line)).catch((err) => disable(sink, err));
}

/**
 * Flush what is queued and close the stream. The sink stays usable: the next append reopens it.
 * @param {Sink} sink
 * @returns {Promise<void>}
 */
export function closeSink(sink) {
  return enqueue(sink, () => endStream(sink)).catch(noop);
}

/** The `then(noop, noop)` tail is load-bearing: without it one failure poisons the whole queue. */
function enqueue(sink, task) {
  const run = sink.queue.then(task);
  sink.queue = run.then(noop, noop);
  return run;
}

async function writeLine(sink, line) {
  if (sink.disabled) return;
  const stream = sink.stream ?? (await openStream(sink));
  // Backpressure: a slow disk must not balloon the manager's memory with buffered lines.
  if (!stream.write(line)) await once(stream, 'drain');
  sink.bytes += Buffer.byteLength(line);
  if (sink.bytes >= sink.maxBytes) await rotate(sink);
}

async function openStream(sink) {
  await mkdir(path.dirname(sink.file), { recursive: true });
  sink.bytes = await stat(sink.file).then((s) => s.size, () => 0);
  const stream = fs.createWriteStream(sink.file, { flags: 'a' });
  // A stream with no 'error' handler turns a full disk into an uncaught exception. Clear only this
  // stream: a rotation may already have installed its successor by the time the failure lands.
  stream.on('error', (err) => {
    if (sink.stream === stream) sink.stream = null;
    stream.destroy();
    disable(sink, err);
  });
  sink.stream = stream;
  return stream;
}

/**
 * Rotation runs inside the write queue and always ends the stream before renaming: renaming out
 * from under an open fd keeps writing to the orphaned inode on POSIX and fails on Windows.
 * `end(cb)` flushes what is buffered; `close()`/`destroy()` does not.
 */
async function rotate(sink) {
  const stream = sink.stream;
  if (!stream) return; // the stream failed between the write and here; persistence is going down
  sink.stream = null;
  sink.bytes = 0;
  await finish(stream);
  const rotated = sink.file.replace(/\.jsonl$/, '.1.jsonl');
  await rm(rotated, { force: true }); // rename over an existing file fails on Windows
  await rename(sink.file, rotated);
}

async function endStream(sink) {
  const stream = sink.stream;
  if (!stream) return;
  sink.stream = null;
  await finish(stream);
}

/**
 * A stream that fails never emits 'finish', so waiting on `end(cb)` alone would hang the queue —
 * and with it shutdown. Settle on whichever of the flush, the failure or the close arrives.
 * @param {fs.WriteStream} stream
 */
function finish(stream) {
  if (stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('close', resolve);
    stream.once('error', resolve);
    stream.end(resolve);
  });
}

function disable(sink, err) {
  sink.stream?.destroy(); // the fd is useless now; leaving it open leaks it for the whole session
  sink.stream = null;
  if (sink.disabled) return; // one message per file, however many writes are already queued
  sink.disabled = true;
  console.error(`[paddock] persistence disabled for ${sink.file}: ${err.message}`);
}

/**
 * Last `n` lines of a file, read backwards in chunks so a large file is never loaded whole.
 * Synchronous on purpose: it runs once per file, off the hot path, and keeps callers' reads sync.
 * @param {string} file
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(file, n) {
  if (n <= 0) return []; // slice(-0) is slice(0) and would return the entire file
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - TAIL_MAX_SCAN_BYTES);
    const chunks = [];
    let pos = size;
    let newlines = 0;
    while (pos > floor && newlines <= n) {
      const length = Math.min(TAIL_CHUNK_BYTES, pos - floor);
      pos -= length;
      const chunk = readFully(fd, pos, length);
      if (!chunk) return []; // short read: the file was truncated under us, so the tail is not ours
      chunks.unshift(chunk);
      newlines += countNewlines(chunk);
    }
    // Decode exactly once: a per-chunk toString() corrupts a multi-byte character on a boundary.
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (pos > 0) lines.shift(); // the first line is the tail end of a line we did not read
    return lines.filter(Boolean).slice(-n);
  } catch {
    return []; // no file yet, or unreadable — cold start simply has no history
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * `readSync` may return fewer bytes than asked for, which would leave a hole in the middle of the
 * concatenated tail. Fill the buffer, or report that the file no longer holds what we meant to
 * read.
 * @returns {Buffer|null}
 */
function readFully(fd, position, length) {
  const chunk = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const bytesRead = fs.readSync(fd, chunk, filled, length - filled, position + filled);
    if (bytesRead <= 0) return null;
    filled += bytesRead;
  }
  return chunk;
}

function countNewlines(chunk) {
  let count = 0;
  for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) count += 1;
  return count;
}
