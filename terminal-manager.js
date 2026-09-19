/**
 * Terminal runtime: interactive shells the dashboard drives, and the only copy of their state.
 *
 * A sibling of `process-manager.js`, and deliberately not part of it. A supervised process is
 * something Paddock starts, watches and reports on; a terminal is something a person types into,
 * and almost nothing the two need is the same. A terminal has no status worth computing, no
 * restart, no crash to classify, and its output is raw bytes with the escape sequences intact —
 * the exact opposite of `log-store.js`, which strips them because a log line is text and this is a
 * screen.
 *
 * Two rules shape the rest. A session outlives the dashboard that opened it, because a reload must
 * not kill the shell someone is halfway through using — which is what the scrollback and the idle
 * timer are for. And a session that nothing is watching must not live forever, because every one of
 * them is a real shell holding real memory.
 *
 * It never reads the JSON DB: callers hand it a resolved directory, exactly as they hand
 * `process-manager.js` a resolved config.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  TERMINAL_ENABLED, TERMINAL_IDLE_TIMEOUT_MS, TERMINAL_MAX_SESSIONS, TERMINAL_SCROLLBACK_BYTES,
} from './config.js';
import { interactiveShell, openPty, ptyAvailability } from './platform/index.js';
import { killGroup, usablePid } from './process-group.js';

/** Bounds on what a client may ask for: a pty rejects zero, and nothing sane is this large. */
const MIN_SIZE = 1;
const MAX_COLS = 1_000;
const MAX_ROWS = 1_000;

export const events = new EventEmitter();

/**
 * @typedef {{id: string, applicationId: string, processId: string|null, processName: string|null,
 *            cwd: string, shell: string, pid: number|null, startedAt: string,
 *            exitedAt: string|null, exitCode: number|null, signal: number|null,
 *            handle: import('./platform/pty.js').PtyHandle|null, scrollback: {chunks: string[],
 *            bytes: number}, subscribers: number, idleTimer: NodeJS.Timeout|null}} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

const nowIso = () => new Date().toISOString();

const warn = (message, err) =>
  console.error(`[paddock] ${message}${err ? `: ${err.message ?? err}` : ''}`);

/** A session with no live pty is a record of one that has ended, kept only for its last output. */
const isLive = (session) => session.handle !== null;

/** What the API hands out: everything but the handle and the bookkeeping behind it. */
const view = (session) => ({
  id: session.id,
  applicationId: session.applicationId,
  processId: session.processId,
  processName: session.processName,
  cwd: session.cwd,
  shell: session.shell,
  pid: session.pid,
  startedAt: session.startedAt,
  exitedAt: session.exitedAt,
  exitCode: session.exitCode,
  signal: session.signal,
  running: isLive(session),
});

/**
 * Whether a terminal can be opened at all, and why not when it cannot. The switch is checked before
 * the binding: an installation that has turned terminals off should say so, not report on a native
 * module it is never going to load.
 * @returns {Promise<{available: boolean, reason: string|null}>}
 */
export async function support() {
  if (!TERMINAL_ENABLED) {
    return { available: false, reason: 'terminals are turned off (PADDOCK_TERMINAL_ENABLED=false)' };
  }
  return ptyAvailability();
}

/**
 * Are there already as many shells open as this installation allows? Asked by the facade, which
 * owns the refusal — the same split as every other "the caller may not do that" in `service.js`.
 * @returns {{full: boolean, open: number, limit: number}}
 */
export const capacity = () => ({
  full: sessions.size >= TERMINAL_MAX_SESSIONS,
  open: sessions.size,
  limit: TERMINAL_MAX_SESSIONS,
});

/** A client's geometry is a hint from a browser, not a promise; clamp it before a pty sees it. */
const clamp = (value, max, fallback) => {
  const size = Math.trunc(Number(value));
  if (!Number.isFinite(size) || size < MIN_SIZE) return fallback;
  return Math.min(size, max);
};

/**
 * The environment a person's shell starts in. `process.env` rather than the login-shell PATH merge
 * `process-manager.js` does: this shell is itself a login shell (see `interactiveShell`), so it is
 * about to read the very profile that merge exists to substitute for.
 *
 * TERM is left to the pty, which sets it from the terminal type it was opened with. The two
 * variables removed are ours and would be lies inside a session: a shell that inherited
 * `FORCE_COLOR=0` from a managed process's environment would print no colour at all.
 */
function sessionEnv() {
  const { FORCE_COLOR, NO_COLOR, ...inherited } = process.env;
  return { ...inherited, TERM_PROGRAM: 'paddock' };
}

/**
 * Keep the tail of what the shell has printed, so a dashboard that reconnects sees the screen it
 * left rather than a blank one with a prompt it will never be sent again.
 *
 * Whole chunks are dropped from the front, never a slice of one: cutting mid-sequence would feed
 * the terminal half an escape, and half an escape is how a replay ends up painting the rest of the
 * session in whatever colour the truncation happened to land on.
 */
function remember(session, chunk) {
  const { scrollback } = session;
  scrollback.chunks.push(chunk);
  scrollback.bytes += Buffer.byteLength(chunk);
  while (scrollback.bytes > TERMINAL_SCROLLBACK_BYTES && scrollback.chunks.length > 1) {
    scrollback.bytes -= Buffer.byteLength(scrollback.chunks.shift());
  }
}

/**
 * Discard a session once nothing has been watching it for long enough. Unref'd, because a pending
 * reap must never be the reason the manager cannot exit.
 */
function scheduleReap(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    // Checked again rather than trusted: a subscriber that arrived while the timer was pending is
    // someone watching this session right now.
    if (session.subscribers > 0) return;
    close(session.id).catch((err) => warn(`could not reap terminal ${session.id}`, err));
  }, TERMINAL_IDLE_TIMEOUT_MS);
  session.idleTimer.unref?.();
}

/**
 * Open a shell in `cwd`. The caller has already resolved and validated the directory and checked
 * `support()` and `capacity()` — this decides neither where a terminal may be opened nor whether
 * one may be, exactly as `process-manager.start` is handed a resolved config and trusts it.
 * @param {{applicationId: string, processId?: string|null, processName?: string|null, cwd: string,
 *          cols?: number, rows?: number}} request
 * @returns {Promise<object>} the session view
 */
export async function open(request) {
  const shell = interactiveShell();
  const handle = await openPty({
    file: shell.file,
    args: shell.args,
    cwd: request.cwd,
    env: sessionEnv(),
    cols: clamp(request.cols, MAX_COLS, 80),
    rows: clamp(request.rows, MAX_ROWS, 24),
  });

  /** @type {Session} */
  const session = {
    id: randomUUID(),
    applicationId: request.applicationId,
    processId: request.processId ?? null,
    processName: request.processName ?? null,
    cwd: request.cwd,
    shell: shell.file,
    pid: usablePid(handle.pid) ? handle.pid : null,
    startedAt: nowIso(),
    exitedAt: null,
    exitCode: null,
    signal: null,
    handle,
    scrollback: { chunks: [], bytes: 0 },
    subscribers: 0,
    idleTimer: null,
  };
  sessions.set(session.id, session);

  handle.onData((chunk) => {
    remember(session, chunk);
    events.emit('data', { sessionId: session.id, chunk });
  });
  handle.onExit(({ exitCode, signal }) => finish(session, exitCode, signal ?? null));

  // The dashboard has not subscribed yet, and may never — a request that opens a session and then
  // fails to reach the stream must not leave a shell running unwatched for the rest of the day.
  scheduleReap(session);
  return view(session);
}

/**
 * The shell has gone. The record stays, holding its last output, so a dashboard reconnecting to a
 * command that killed the shell can still read what it said before it did.
 */
function finish(session, exitCode, signal) {
  if (!isLive(session)) return;
  session.handle = null;
  session.exitedAt = nowIso();
  session.exitCode = exitCode ?? null;
  session.signal = signal;
  events.emit('exit', { sessionId: session.id, exitCode: session.exitCode, signal });
  // Nothing is going to type into a dead shell, so the record is on the clock from here whether or
  // not anyone is still reading it — unless `close` is what got us here, and the record is already
  // gone.
  if (sessions.has(session.id)) scheduleReap(session);
}

/**
 * An unknown id is reported as `false`/`null` rather than thrown, so that "no such terminal" is
 * turned into a 404 in one place — `service.js`, which owns the error vocabulary the HTTP layer
 * reads. Nothing down here decides what a caller's mistake looks like over the wire.
 *
 * Send keystrokes. Writing to a shell that has exited is not an error: a keystroke and an exit
 * cross on the wire routinely, and there is nothing for the user to fix.
 * @param {string} id @param {string} data
 * @returns {boolean} false when there is no such session
 */
export function write(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  if (isLive(session)) session.handle.write(data);
  return true;
}

/**
 * @param {string} id @param {number} cols @param {number} rows
 * @returns {boolean} false when there is no such session
 */
export function resize(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  if (isLive(session)) session.handle.resize(clamp(cols, MAX_COLS, 80), clamp(rows, MAX_ROWS, 24));
  return true;
}

/**
 * Follow a session's output. The replay goes to this listener alone rather than through the shared
 * emitter, so a second dashboard opening the same terminal does not repaint everyone else's.
 * @param {string} id
 * @param {{onData: (chunk: string) => void, onExit: (event: object) => void}} listener
 * @returns {(() => void)|null} unsubscribe, or null when there is no such session
 */
export function subscribe(id, listener) {
  const session = sessions.get(id);
  if (!session) return null;
  session.subscribers += 1;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;

  for (const chunk of session.scrollback.chunks) listener.onData(chunk);
  // A session that ended before this subscriber arrived still owes it the exit: without this the
  // replay would stop at the last line and the tab would sit there looking live.
  if (!isLive(session)) {
    listener.onExit({ sessionId: session.id, exitCode: session.exitCode, signal: session.signal });
  }

  const onData = (event) => {
    if (event.sessionId === session.id) listener.onData(event.chunk);
  };
  const onExit = (event) => {
    if (event.sessionId === session.id) listener.onExit(event);
  };
  events.on('data', onData);
  events.on('exit', onExit);

  let released = false;
  return () => {
    // 'close' and 'error' can both fire for one disconnect; releasing twice would drop the count
    // below zero and leave a live session that never gets reaped.
    if (released) return;
    released = true;
    events.off('data', onData);
    events.off('exit', onExit);
    session.subscribers -= 1;
    if (session.subscribers === 0 && sessions.has(session.id)) scheduleReap(session);
  };
}

/**
 * End a session and forget it.
 *
 * Hanging up comes first, by closing the pty master: that is what closing a terminal *is*, it is
 * the signal an interactive shell is built to exit on, and the kernel delivers it to everything
 * else holding the tty. It also has to come first because an interactive shell deliberately
 * ignores SIGTERM — leading with the group signal would mean every stop sat out the whole grace
 * period waiting for a shell that was never going to answer it.
 *
 * The group signal stays, behind it, for what a hangup does not reach: something started with
 * `nohup`, or anything that chose to ignore it. The group and not the shell, because a terminal's
 * shell is a session leader, so whatever it started is in there with it.
 * @param {string} id
 * @returns {Promise<boolean>} false when there was no such session
 */
export async function close(id) {
  const session = sessions.get(id);
  if (!session) return false;
  // Removed first, so the `finish` below sees a session that is no longer ours and does not put it
  // back on the reap timer this call is the completion of.
  sessions.delete(id);
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
  session.handle?.destroy();
  finish(session, null, null);
  if (session.pid !== null) {
    await killGroup(session.pid).catch((err) => warn(`could not stop terminal ${id}`, err));
  }
  return true;
}

/** @param {string} id @returns {object|null} the session view, or null when there is no such one */
export const get = (id) => {
  const session = sessions.get(id);
  return session ? view(session) : null;
};

/**
 * @param {string} [applicationId] every session when absent
 * @returns {object[]} oldest first, so tabs keep the order they were opened in
 */
export const list = (applicationId) =>
  [...sessions.values()]
    .filter((session) => !applicationId || session.applicationId === applicationId)
    .map(view)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/** @param {string} applicationId */
export const closeApplication = (applicationId) =>
  Promise.all(list(applicationId).map((session) => close(session.id)));

/** Every shell goes down with the manager: they are its children and nothing else can reach them. */
export const closeAll = () => Promise.all([...sessions.keys()].map((id) => close(id)));
