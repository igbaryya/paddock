/**
 * PostgreSQL servers, run through pg_ctl. Unlike process-manager this module holds no process: pg_ctl
 * daemonises the postmaster into a session of its own, so stopping, restarting or killing Paddock
 * never takes a server down with it, and a server may be up long before Paddock is.
 *
 * So nothing here is remembered as fact. A server's state is an observation of its data directory,
 * taken again on every read and around every action; this module only adds what the directory cannot
 * say — that a stop is in flight, why the last start failed, how many restarts there were. A server
 * started from a terminal reads as running, and one stopped from a terminal reads as stopped.
 *
 * It never reads the JSON DB: callers hand it a resolved server from `cluster.serverOf`.
 */
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { append } from '../log-store.js';
import { SERVER_PROCESS_ID } from './cluster.js';
import { inspect } from './data-directory.js';
import * as follower from './log-follower.js';

/** How long pg_ctl waits for a start or a stop to finish — a shutdown checkpoint can take a while. */
const PG_CTL_WAIT_SECONDS = 60;
/** pg_ctl's own wait, plus room for it to report why it gave up. */
const PG_CTL_TIMEOUT_MS = (PG_CTL_WAIT_SECONDS + 10) * 1_000;
const ACTIVE = new Set(['starting', 'running', 'stopping']);
/** The lines of a server log that say why it would not start. */
const FAILURE_LINE = /\b(?:FATAL|PANIC):/;

export const events = new EventEmitter();

/** @type {Map<string, object>} one record per application */
const records = new Map();
/** @type {Map<string, Promise<unknown>>} promise-chain mutex per application */
const locks = new Map();

const noop = () => {};
const nowIso = () => new Date().toISOString();

/** Serialise actions per server; `.then(noop, noop)` keeps one failure from poisoning the chain. */
function withLock(key, fn) {
  const tail = locks.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  locks.set(key, run.then(noop, noop));
  return run;
}

const newRecord = (applicationId) => ({
  applicationId,
  status: 'stopped',
  pid: null,
  port: null,
  startedAt: null,
  stoppedAt: null,
  lastError: null,
  restarts: 0,
  // Set while pg_ctl runs, so an observation taken mid-action does not overwrite `starting` or
  // `stopping` with whatever the pid file said a moment before the action reached the server.
  acting: false,
});

function ensureRecord(applicationId) {
  if (!records.has(applicationId)) records.set(applicationId, newRecord(applicationId));
  return records.get(applicationId);
}

/** The same shape process-manager reports, plus the port the server is really listening on. */
const publicState = (rec) => ({
  status: rec.status,
  pid: rec.pid,
  port: rec.port,
  startedAt: rec.startedAt,
  stoppedAt: rec.stoppedAt,
  exitCode: null,
  exitSignal: null,
  lastError: rec.lastError,
  restarts: rec.restarts,
  uptimeMs: ACTIVE.has(rec.status) && rec.startedAt ? Date.now() - Date.parse(rec.startedAt) : null,
});

const emitStatus = (rec) => events.emit('status', {
  applicationId: rec.applicationId,
  processId: SERVER_PROCESS_ID,
  state: publicState(rec),
});

/** What a dashboard would notice changing; uptime ticking by is not a status change. */
const fingerprintOf = (rec) => JSON.stringify([rec.status, rec.pid, rec.port, rec.lastError]);

// --- observation ---------------------------------------------------------------------------

function applyRunning(rec, seen) {
  if (!ACTIVE.has(rec.status)) rec.lastError = null;   // up again, whoever brought it up
  rec.pid = seen.pid;
  rec.port = seen.port;
  rec.startedAt = seen.startedAt;
  if (!rec.acting) rec.status = seen.phase;
}

/**
 * Gone. Only a server that was up becomes `stopped` or `crashed` here: a `failed` start keeps saying
 * so until something else happens, and a first look at a stale pid file is history from before
 * Paddock, not a crash it saw.
 */
function applyDown(rec, seen) {
  const wasUp = ACTIVE.has(rec.status);
  rec.pid = null;
  rec.port = null;
  if (rec.acting || !wasUp) return;
  rec.stoppedAt = nowIso();
  rec.status = seen.stale ? 'crashed' : 'stopped';
  if (seen.stale) rec.lastError = 'the server exited without removing postmaster.pid — it did not shut down cleanly';
}

/** Each line the server logs reaches the log store and the dashboards, like a process's output. */
function followLog(server) {
  const onLine = (line) => {
    // pg_ctl sends both streams into one file, so which one a line came from is not recorded.
    const entry = append(server.applicationId, SERVER_PROCESS_ID, 'stdout', line);
    events.emit('log', { ...entry, applicationId: server.applicationId, processId: SERVER_PROCESS_ID });
  };
  return follower.follow(server.applicationId, server.logFile, onLine);
}

async function observe(rec, server) {
  const before = fingerprintOf(rec);
  const seen = await inspect(server.dataDirectory);
  if (seen.running) applyRunning(rec, seen);
  else applyDown(rec, seen);
  await followLog(server);
  if (fingerprintOf(rec) !== before) emitStatus(rec);
}

// --- pg_ctl --------------------------------------------------------------------------------

/**
 * Locale pg_ctl (and the postmaster it starts) run under. A Paddock started at login has none —
 * launchd does not set LANG — and on macOS `setlocale("")` then pulls in CoreFoundation, which
 * threads the postmaster before it can fork: FATAL "postmaster became multithreaded during startup",
 * with PostgreSQL's own hint to set LC_ALL. A locale already in the environment is left alone.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function pgCtlEnv(env = process.env) {
  if (['LC_ALL', 'LANG', 'LC_CTYPE'].some((key) => env[key]?.trim())) return env;
  return { ...env, LC_ALL: 'C' };
}

/**
 * Run pg_ctl without a shell, and resolve either way: a start that fails is an outcome to report,
 * not an exception. pg_ctl redirects the server's own output to the log file, so the pipes close
 * when pg_ctl exits even though the server lives on.
 * @param {string} pgCtl @param {string[]} args
 * @returns {Promise<{ok: boolean, output: string, error: Error|null}>}
 */
const runPgCtl = (pgCtl, args) => new Promise((resolve) => {
  execFile(pgCtl, args, { timeout: PG_CTL_TIMEOUT_MS, encoding: 'utf8', env: pgCtlEnv() }, (error, stdout, stderr) => {
    resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim(), error });
  });
});

const logSize = (file) => fs.stat(file).then((stats) => stats.size, () => 0);

/** What the server logged since byte `offset` — only this attempt's lines, never an older failure. */
async function loggedSince(file, offset) {
  const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0));
  return bytes.subarray(offset).toString('utf8').split('\n');
}

/**
 * pg_ctl only says that it failed ("could not start server — Examine the log output"); the reason is
 * the server's FATAL line in the log. Both go into lastError, so an agent does not need a second call.
 */
async function failureReason(server, outcome, logOffset) {
  if (outcome.error?.code === 'ENOENT') {
    return `${server.pgCtl} was not found — set the bin directory, or put pg_ctl on Paddock's PATH`;
  }
  const said = outcome.output.split('\n').find((line) => line.startsWith('pg_ctl:')) ?? outcome.error.message;
  const fatal = (await loggedSince(server.logFile, logOffset)).findLast((line) => FAILURE_LINE.test(line));
  return fatal ? `${said.trim()} — ${fatal.trim()}` : said.trim();
}

/** Mark the in-flight action, run pg_ctl, and record why it failed if it did. */
async function act(rec, server, status, args) {
  rec.acting = true;
  rec.status = status;
  rec.lastError = null;
  emitStatus(rec);
  const logOffset = await logSize(server.logFile);
  const outcome = await runPgCtl(server.pgCtl, args);
  rec.acting = false;
  if (!outcome.ok) rec.lastError = await failureReason(server, outcome, logOffset);
  return outcome;
}

// --- public API ----------------------------------------------------------------------------

/**
 * The server's state as of now, read from its data directory.
 * @param {{applicationId: string, dataDirectory: string, logFile: string}} server
 */
export async function refresh(server) {
  const rec = ensureRecord(server.applicationId);
  await observe(rec, server);
  return publicState(rec);
}

/** @param {string} applicationId @returns {object} the last observation — a stopped default before any */
export function getState(applicationId) {
  return publicState(records.get(applicationId) ?? newRecord(applicationId));
}

/** @param {string} applicationId as of the last observation */
export function isActive(applicationId) {
  return ACTIVE.has(records.get(applicationId)?.status ?? 'stopped');
}

/**
 * Start the server unless it is already up — whoever started it. Resolves once pg_ctl has waited for
 * it to accept connections, or given up.
 * @param {object} server from `cluster.serverOf`
 */
export function start(server) {
  const rec = ensureRecord(server.applicationId);
  return withLock(server.applicationId, async () => {
    await observe(rec, server);
    if (ACTIVE.has(rec.status)) return publicState(rec);
    // pg_ctl opens the log file, but will not create the directory Paddock's default one lives in.
    await fs.mkdir(path.dirname(server.logFile), { recursive: true });
    const { dataDirectory, logFile, port } = server;
    const args = ['start', '-D', dataDirectory, '-l', logFile, '-o', `-p ${port}`, '-w', '-t', String(PG_CTL_WAIT_SECONDS)];
    const outcome = await act(rec, server, 'starting', args);
    if (!outcome.ok) rec.status = 'failed';
    await observe(rec, server);
    emitStatus(rec);
    return publicState(rec);
  });
}

/**
 * Stop the server — whoever started it — with a fast shutdown: sessions are terminated and a
 * shutdown checkpoint written. A smart shutdown would wait for every client to leave, and a dev
 * server's connection pool never does.
 * @param {object} server from `cluster.serverOf`
 */
export function stop(server) {
  const rec = ensureRecord(server.applicationId);
  return withLock(server.applicationId, async () => {
    await observe(rec, server);
    if (!ACTIVE.has(rec.status)) return acknowledgeDown(rec);
    const args = ['stop', '-D', server.dataDirectory, '-m', 'fast', '-w', '-t', String(PG_CTL_WAIT_SECONDS)];
    await act(rec, server, 'stopping', args);
    // `stopping` was only ours while pg_ctl ran; the directory decides what the server is now.
    await observe(rec, server);
    emitStatus(rec);
    return publicState(rec);
  });
}

/**
 * Stopping a server that is not running is the user clearing a failed start or a crash: it settles
 * to `stopped`, keeping `lastError` so the reason stays on the record.
 */
function acknowledgeDown(rec) {
  if (rec.status === 'failed' || rec.status === 'crashed') {
    rec.status = 'stopped';
    emitStatus(rec);
  }
  return publicState(rec);
}

/** @param {object} server from `cluster.serverOf` */
export async function restart(server) {
  await stop(server);
  ensureRecord(server.applicationId).restarts += 1;
  return start(server);
}

/** Forget a deleted application. Its server is left exactly as it is, running or not. */
export function forget(applicationId) {
  follower.unfollow(applicationId);
  records.delete(applicationId);
  locks.delete(applicationId);
}

/** Shutdown: stop reading log files. Every server keeps running — that is the point of pg_ctl. */
export function close() {
  follower.unfollowAll();
}
