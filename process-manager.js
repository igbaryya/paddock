/**
 * Process runtime: spawn, supervise and stop the user's dev servers, and hold the only copy of
 * their live state. The shape of this module follows one rule that overrides the obvious design:
 * a process is "stopped" when its process *group* is gone — probed with `treeAlive` — not when
 * the child's `'exit'` event fires. `'exit'` reports the direct child only, and fires while
 * grandchildren still hold the ports a restart needs. Everything else here (the retained pgid, the
 * generation counter on every handler, the synchronous state flips) exists to keep that probe
 * honest under restarts and concurrent callers.
 *
 * It never reads the JSON DB — callers hand it a resolved process config — and never branches
 * on `process.platform`; every OS-specific step goes through `platform/`.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_FILE, STOP_GRACE_MS, START_SETTLE_MS, REAP_ORPHANS } from './config.js';
import {
  shellInvocation, spawnOptions, signalTree, killTreeSync, treeAlive, describeLeader,
  loginShellPath,
} from './platform/index.js';
import { append } from './log-store.js';

const GROUP_POLL_MS = 100;
const EXIT_FLUSH_MS = 50;
const EXIT_DRAIN_MS = 500;
const KILL_WAIT_MS = 10_000;
const LINGER_POLL_MS = 1_000;
const LOGIN_PATH_TIMEOUT_MS = 3_000;
/** A process lock key is `appId:procId`, so a key without a colon cannot collide with one. */
const RUNTIME_LOCK_KEY = 'runtime-file';
const ACTIVE = new Set(['starting', 'running', 'stopping']);

export const events = new EventEmitter();

/** @type {Map<string, object>} runtime record per process, keyed `applicationId:processId` */
const states = new Map();
/** @type {Map<string, Promise<unknown>>} promise-chain mutex per key */
const locks = new Map();

const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (applicationId, processId) => `${applicationId}:${processId}`;
const nowIso = () => new Date().toISOString();
const isActiveStatus = (status) => ACTIVE.has(status);
/** `process.kill(0, …)` addresses our own group, so a probe needs a genuine pid first. */
const usablePid = (pid) => Number.isInteger(pid) && pid > 0;
const warn = (message, err) =>
  console.error(`[paddock] ${message}${err ? `: ${err.message ?? err}` : ''}`);

/**
 * Serialise work per key. FINDINGS F3: `run.then(noop, noop)` is load-bearing — without it the
 * first rejection poisons the chain and every later caller fast-fails with a stale error.
 * @param {string} key
 * @param {() => Promise<unknown>} fn
 */
function withLock(key, fn) {
  const tail = locks.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  locks.set(key, run.then(noop, noop));
  return run;
}

const newRecord = (applicationId, processId) => ({
  applicationId,
  processId,
  status: 'stopped',
  // Retained until the group is confirmed gone, independent of status (FINDINGS B6): a wrapper
  // shell that exits during startup leaves a dev server holding a port that stop() must still kill.
  pgid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  exitSignal: null,
  lastError: null,
  restarts: 0,
  child: null,
  generation: 0,
  settleTimer: null,
  settleDone: null,
  stopRequested: false,
  finalised: true,
  forgotten: false,
  lastStderr: null,
});

function ensureRecord(applicationId, processId) {
  const key = keyOf(applicationId, processId);
  let rec = states.get(key);
  if (!rec) {
    rec = newRecord(applicationId, processId);
    states.set(key, rec);
  }
  return rec;
}

/** `uptimeMs` is derived here rather than stored, so it never goes stale. */
const uptimeOf = (rec) =>
  (isActiveStatus(rec.status) && rec.startedAt ? Date.now() - Date.parse(rec.startedAt) : null);

const publicState = (rec) => ({
  status: rec.status,
  pid: rec.pgid,
  startedAt: rec.startedAt,
  stoppedAt: rec.stoppedAt,
  exitCode: rec.exitCode,
  exitSignal: rec.exitSignal,
  lastError: rec.lastError,
  restarts: rec.restarts,
  uptimeMs: uptimeOf(rec),
});

const emitStatus = (rec) => events.emit('status', {
  applicationId: rec.applicationId,
  processId: rec.processId,
  state: publicState(rec),
});

// --- child environment ---------------------------------------------------------------------

let pathEnvPromise = null;
const resolvedPathEnv = () => (pathEnvPromise ??= resolveLoginPathEnv());

/**
 * A manager launched from Finder/Dock/launchd inherits a minimal PATH with no nvm and no homebrew,
 * and every `npm run dev` fails (FINDINGS G2). Merge the login shell's entries in — additively,
 * because the inherited PATH may legitimately be the richer one. Resolved once, lazily.
 */
async function resolveLoginPathEnv() {
  const loginPath = await loginShellPath(LOGIN_PATH_TIMEOUT_MS).catch(() => null);
  if (!loginPath) return {};
  const inherited = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const entries = loginPath.split(path.delimiter);
  const missing = entries.filter((entry) => entry && !inherited.includes(entry));
  if (!missing.length) return {};
  return { PATH: [...inherited, ...missing].join(path.delimiter) };
}

/** @param {Record<string,string>} [overrides] */
async function childEnv(overrides) {
  return {
    ...process.env,
    ...(await resolvedPathEnv()),
    ...overrides,
    // We strip ANSI anyway; NO_COLOR is deliberately not set alongside it (FINDINGS D5).
    FORCE_COLOR: '0',
    PYTHONUNBUFFERED: '1',
  };
}

// --- output capture ------------------------------------------------------------------------

const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Chunk-to-line splitter that holds back a trailing lone `\r` until the next chunk, so a CRLF
 * straddling a chunk boundary is not torn into a bogus line plus an empty one (FINDINGS D3).
 */
const createLineSplitter = () => {
  let residual = '';
  return {
    /** @param {string} chunk @returns {string[]} */
    push(chunk) {
      residual += chunk;
      const held = residual.endsWith('\r');
      const parts = (held ? residual.slice(0, -1) : residual).split(LINE_BREAK);
      residual = parts.pop() + (held ? '\r' : '');
      return parts;
    },
    /** @returns {string[]} whatever is left, so a final line without a newline is not lost */
    flush() {
      const rest = residual.endsWith('\r') ? residual.slice(0, -1) : residual;
      residual = '';
      return rest ? rest.split(LINE_BREAK) : [];
    },
  };
};

/** Both streams must be drained or the child blocks at ~192 KB (FINDINGS D1). */
function attachStreams(rec, child, generation) {
  captureStream(rec, generation, child.stdout, 'stdout');
  captureStream(rec, generation, child.stderr, 'stderr');
}

function captureStream(rec, generation, stream, name) {
  if (!stream) return;
  const splitter = createLineSplitter();
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of splitter.push(chunk)) emitLine(rec, generation, name, line);
  });
  // Output keeps arriving after 'exit' (FINDINGS B4): only the pipe closing ends capture.
  stream.on('end', () => {
    for (const line of splitter.flush()) emitLine(rec, generation, name, line);
  });
  stream.on('error', (err) => warn(`${name} pipe error for ${rec.processId}`, err));
}

function emitLine(rec, generation, stream, message) {
  // A forgotten process has had its buffer cleared and its config deleted; appending a late line
  // would rebuild a view of something that no longer exists and that nothing will clear again.
  if (rec.forgotten) return;
  const entry = append(rec.applicationId, rec.processId, stream, message);
  // Startup errors quote the last stderr line, so only the live incarnation may set it.
  if (stream === 'stderr' && rec.generation === generation) rec.lastStderr = entry.message;
  events.emit('log', { ...entry, applicationId: rec.applicationId, processId: rec.processId });
}

// --- process group operations --------------------------------------------------------------

/**
 * Poll the group until it is gone. The probe — not any child event — is what "stopped" means.
 * @param {number|null} pgid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when the group is confirmed gone
 */
async function awaitGroupGone(pgid, timeoutMs) {
  if (!usablePid(pgid)) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!treeAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
}

/** SIGTERM, poll, escalate to SIGKILL at the grace deadline, keep polling (FINDINGS B5). */
async function killGroup(pgid) {
  if (!usablePid(pgid)) return true;
  await signalTree(pgid, { force: false });
  if (await awaitGroupGone(pgid, STOP_GRACE_MS)) return true;
  await signalTree(pgid, { force: true });
  return awaitGroupGone(pgid, KILL_WAIT_MS);
}

/** Drop our claim on a group that is gone: the pgid and its orphan-reaper record go together. */
function releaseGroup(rec) {
  if (rec.pgid == null) return;
  rec.pgid = null;
  removeRuntimeEntry(rec).catch((err) => warn('could not update the runtime file', err));
}

/**
 * A group that outlives its finalised process keeps its pgid so stop() can still reach it; this
 * watcher notices when it finally dies. Unref'd — it must never hold the manager open (E4).
 */
function watchLingeringGroup(rec, generation) {
  const timer = setInterval(() => {
    if (rec.generation !== generation || rec.pgid == null) return clearInterval(timer);
    if (treeAlive(rec.pgid)) return;
    clearInterval(timer);
    releaseGroup(rec);
    rec.lastError = null;
    emitStatus(rec);
  }, LINGER_POLL_MS);
  timer.unref?.();
}

// --- state transitions ---------------------------------------------------------------------

function clearSettleTimer(rec) {
  if (!rec.settleTimer) return;
  clearTimeout(rec.settleTimer);
  rec.settleTimer = null;
}

/**
 * Close one incarnation exactly once. `'error'` is terminal on its own and is followed by a
 * `'close'` carrying a negative errno (FINDINGS C1), so the guard here is what keeps the two paths
 * from finalising the same incarnation twice.
 * @param {object} rec
 * @param {{status:string, lastError?:string|null, groupGone:boolean}} outcome
 */
function finalise(rec, outcome) {
  if (rec.finalised) return publicState(rec);
  rec.finalised = true;
  clearSettleTimer(rec);
  rec.child = null;
  rec.status = outcome.status;
  rec.lastError = outcome.lastError ?? null;
  rec.stoppedAt = nowIso();
  rec.stopRequested = false;
  if (outcome.groupGone) releaseGroup(rec);
  else watchLingeringGroup(rec, rec.generation);
  emitStatus(rec);
  resolveSettle(rec);
  return publicState(rec);
}

const exitDescription = (rec) =>
  (rec.exitSignal ? `terminated by ${rec.exitSignal}` : `exited with code ${rec.exitCode}`);

const lingerNote = (rec) =>
  `its process group (${rec.pgid}) is still running and still holds any ports it opened`;

/** Report `code`/`signal` verbatim — exit codes are not ours to interpret (FINDINGS C3). */
function classifyExit(rec, wasStarting, groupGone) {
  const note = groupGone ? null : lingerNote(rec);
  const withNote = (message) => (note ? `${message}; ${note}` : message);
  if (rec.stopRequested) return { status: 'stopped', lastError: note, groupGone };
  if (wasStarting) {
    const tail = rec.lastStderr ? `: ${rec.lastStderr}` : '';
    const message = `${exitDescription(rec)} during startup${tail}`;
    return { status: 'crashed', lastError: withNote(message), groupGone };
  }
  if (rec.exitCode === 0 && !rec.exitSignal) {
    const message = 'exited cleanly without being asked to stop';
    return { status: 'stopped', lastError: withNote(message), groupGone };
  }
  return { status: 'crashed', lastError: withNote(exitDescription(rec)), groupGone };
}

/**
 * The `'exit'` event is evidence, not a verdict: record what it reports, then ask the group.
 * The synchronous prefix runs before any replacement child can be adopted.
 */
async function onChildExit(rec, generation, code, signal) {
  if (rec.generation !== generation) return;  // F2: a killed child outlives its own restart
  const wasStarting = rec.status === 'starting';
  clearSettleTimer(rec);
  rec.exitCode = code;
  rec.exitSignal = signal;
  if (rec.finalised) {
    emitStatus(rec);
    return;
  }
  await sleep(EXIT_FLUSH_MS);                 // late stdout/stderr still arrives (FINDINGS B4)
  const groupGone = await awaitGroupGone(rec.pgid, EXIT_DRAIN_MS);
  if (rec.generation !== generation) return;
  finalise(rec, classifyExit(rec, wasStarting, groupGone));
}

function onChildError(rec, generation, err) {
  if (rec.generation !== generation) return;
  finalise(rec, {
    status: 'failed',
    lastError: `could not run the command: ${err.message}`,
    groupGone: rec.pgid == null,
  });
}

function promoteToRunning(rec) {
  rec.status = 'running';
  emitStatus(rec);
  // The leader's command line mutates once the shell exec-optimises into the user's command
  // (`/bin/sh -c npm run dev` becomes `npm run dev` under the same pid), so the fingerprint the
  // reaper will compare against has to be taken from the settled process, not the fresh one.
  recordRuntimeEntry(rec).catch((err) => warn('could not update the runtime file', err));
}

/**
 * Hand `start()` its answer, exactly once. Every exit from the startup window goes through here,
 * including the ones that do not promote: `launch` holds the per-process lock until this fires, so
 * a window that ends without resolving wedges the lock and every later call on that process.
 */
function resolveSettle(rec) {
  const done = rec.settleDone;
  rec.settleDone = null;
  done?.();
}

/**
 * Resolve when the process has proved it survives startup, or when it died trying. The timer is
 * also the crash window: an exit before it fires is a startup failure, not a clean stop.
 */
function settle(rec) {
  const generation = rec.generation;
  return new Promise((resolve) => {
    rec.settleDone = () => resolve(publicState(rec));
    rec.settleTimer = setTimeout(() => {
      rec.settleTimer = null;
      // A stop that arrived inside the window already moved the status on; the promotion is what
      // it cancels, not the resolution.
      if (rec.generation === generation && rec.status === 'starting') promoteToRunning(rec);
      resolveSettle(rec);
    }, START_SETTLE_MS);
  });
}

// --- spawning ------------------------------------------------------------------------------

/** A bad cwd surfaces as `spawn /bin/sh ENOENT`, which names the wrong thing (FINDINGS C2). */
async function assertDirectory(cwd) {
  const stats = await fs.stat(cwd).catch(() => null);
  if (!stats) throw new Error(`working directory does not exist: ${cwd}`);
  if (!stats.isDirectory()) throw new Error(`working directory is not a directory: ${cwd}`);
}

function spawnChild(command, cwd, env) {
  const { file, args } = shellInvocation(command);
  // stdin is 'pipe' and never ended: 'ignore' is an immediate EOF some dev servers quit on, and
  // 'inherit' lets a detached child steal the user's keystrokes (FINDINGS D2).
  const stdio = ['pipe', 'pipe', 'pipe'];
  return spawn(file, args, { cwd, env, stdio, ...spawnOptions({ cwd, env }) });
}

function adoptChild(rec, child, generation) {
  rec.child = child;
  // `detached: true` makes the child its own group leader, so child.pid is the pgid (FINDINGS A2).
  rec.pgid = usablePid(child.pid) ? child.pid : null;
  rec.startedAt = nowIso();
  rec.stoppedAt = null;
  rec.exitCode = null;
  rec.exitSignal = null;
  rec.lastError = null;
  rec.lastStderr = null;
  attachStreams(rec, child, generation);
  child.on('error', (err) => onChildError(rec, generation, err));
  child.on('exit', (code, signal) => onChildExit(rec, generation, code, signal));
  emitStatus(rec);
}

/**
 * A previous incarnation whose group outlived it (FINDINGS B6) still holds its ports, and adopting
 * a new child would overwrite the pgid that is the only handle reaching it. Kill it first.
 */
async function reclaimLingeringGroup(rec) {
  if (rec.pgid == null) return;
  const pgid = rec.pgid;
  const gone = await killGroup(pgid).catch((err) => warn(`could not kill group ${pgid}`, err));
  if (gone) return releaseGroup(rec);
  warn(`group ${pgid} outlived ${rec.processId} and survived the kill — it is now unreachable`);
}

async function launch(rec, cfg) {
  const cwd = cfg.workingDirectory || cfg.repositoryPath;
  // Bumped first so the previous incarnation's linger watcher stands down: the kill below polls
  // the same group, and two pollers racing to release it is how a live pgid gets dropped.
  const generation = ++rec.generation;
  await reclaimLingeringGroup(rec);
  try {
    await assertDirectory(cwd);
    const child = spawnChild(cfg.command, cwd, await childEnv(cfg.env));
    adoptChild(rec, child, generation);
  } catch (err) {
    // pgid is normally null here (nothing spawned); if anything after the spawn threw, the group
    // it created must be kept rather than released, or nothing could ever reach it again.
    finalise(rec, { status: 'failed', lastError: err.message, groupGone: rec.pgid == null });
    throw err;
  }
  // Registered before the event loop can deliver 'exit', so a child that dies immediately resolves
  // this rather than leaving start() waiting out the whole window.
  const settled = settle(rec);
  recordRuntimeEntry(rec).catch((err) => warn('could not update the runtime file', err));
  return settled;
}

/**
 * A stop that cannot signal (POSIX EPERM) must still leave a verdict: nothing else would finalise
 * the record, and a process stuck in `stopping` is one `start()` can never revive.
 */
const signalFailure = (pgid, err) => ({
  status: 'failed',
  lastError: `could not signal process group ${pgid}: ${err.message}`,
  groupGone: false,
});

const killVerdict = (pgid, gone) => ({
  status: gone ? 'stopped' : 'failed',
  lastError: gone ? null : `process group ${pgid} is still alive after SIGKILL`,
  groupGone: gone,
});

async function terminate(rec) {
  const pgid = rec.pgid;
  const outcome = await killGroup(pgid)
    .then((gone) => killVerdict(pgid, gone), (err) => signalFailure(pgid, err));
  // The child's own 'exit' handler may have finalised while we were waiting on the group. Ours is
  // the later probe and the one that actually escalated, so it is the verdict that stands.
  rec.finalised = false;
  return finalise(rec, outcome);
}

// --- orphan reaper record ------------------------------------------------------------------

const sameEntry = (entry, rec) =>
  entry.applicationId === rec.applicationId && entry.processId === rec.processId;

async function readRuntimeFile() {
  const raw = await fs.readFile(RUNTIME_FILE, 'utf8').catch(() => null);
  if (raw === null) return { version: 1, processes: [] };
  try {
    const doc = JSON.parse(raw);
    return { version: 1, processes: Array.isArray(doc?.processes) ? doc.processes : [] };
  } catch {
    // Disposable state: a torn or hand-edited file costs us nothing to discard.
    return { version: 1, processes: [] };
  }
}

async function writeRuntimeFile(doc) {
  const tmp = `${RUNTIME_FILE}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(RUNTIME_FILE), { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    // Rename into place so a manager killed mid-write still reads a complete record list; no fsync,
    // because a record lost to a power cut describes a process that did not survive it either.
    await fs.rename(tmp, RUNTIME_FILE);
  } catch (err) {
    // A full disk fails the write, not the rename, and the partial sibling would otherwise stay.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const updateRuntimeFile = (mutate) =>
  withLock(RUNTIME_LOCK_KEY, async () => writeRuntimeFile(await mutate(await readRuntimeFile())));

/**
 * Persist what a future manager needs to recognise this group: the pgid plus the leader's identity.
 * A leader we cannot fingerprint is a record we would never be allowed to act on, so we skip it.
 */
const recordRuntimeEntry = (rec) => updateRuntimeFile(async (doc) => {
  const leader = rec.pgid == null ? null : await describeLeader(rec.pgid).catch(() => null);
  const kept = doc.processes.filter((entry) => !sameEntry(entry, rec));
  if (!leader) return { ...doc, processes: kept };
  return {
    ...doc,
    processes: [...kept, {
      applicationId: rec.applicationId,
      processId: rec.processId,
      pgid: rec.pgid,
      command: leader.command,
      leaderStartedAt: leader.startedAt,
      recordedAt: nowIso(),
    }],
  };
});

const removeRuntimeEntry = (rec) => updateRuntimeFile((doc) => ({
  ...doc,
  processes: doc.processes.filter((entry) => !sameEntry(entry, rec)),
}));

/**
 * Pgids are reused and `ps -o lstart=` has 1-second granularity, so a record may only be acted on
 * when the live leader matches BOTH the recorded command and the recorded start time.
 */
async function reapEntry(entry) {
  if (!usablePid(entry?.pgid) || !entry.command || !entry.leaderStartedAt) return false;
  const leader = await describeLeader(entry.pgid).catch(() => null);
  if (!leader) return false;
  if (leader.command !== entry.command || leader.startedAt !== entry.leaderStartedAt) return false;
  // One unsignallable leftover must not abort the sweep over the rest of the records.
  return killGroup(entry.pgid).catch((err) => {
    warn(`could not reap orphaned process group ${entry.pgid}`, err);
    return false;
  });
}

// --- public API ----------------------------------------------------------------------------

/**
 * Start a process, resolving once it has survived the startup window or died inside it.
 * @param {object} cfg resolved process config plus `applicationId`
 * @returns {Promise<object>} RuntimeState
 */
export async function start(cfg) {
  const rec = ensureRecord(cfg.applicationId, cfg.id);
  // FINDINGS F1: the flip is synchronous, before any await, which is what makes a concurrent
  // start() a no-op instead of a second spawn.
  if (isActiveStatus(rec.status)) return publicState(rec);
  rec.status = 'starting';
  rec.finalised = false;
  rec.stopRequested = false;
  emitStatus(rec);
  return withLock(keyOf(cfg.applicationId, cfg.id), () => launch(rec, cfg));
}

/**
 * Stopping something that already died of its own accord is the user acknowledging the crash, so
 * it settles to `stopped` — otherwise an application with one crashed process reads FAILED forever
 * and no amount of stopping can clear it. `exitCode` / `exitSignal` / `lastError` are kept, so why
 * it died is still on the record.
 * @param {object} rec
 */
function acknowledgeDead(rec) {
  if (rec.status !== 'crashed' && rec.status !== 'failed') return publicState(rec);
  rec.status = 'stopped';
  emitStatus(rec);
  return publicState(rec);
}

/**
 * Stop a process and its whole group, resolving only once the group is confirmed gone.
 * @param {string} applicationId
 * @param {string} processId
 * @returns {Promise<object>} RuntimeState
 */
export async function stop(applicationId, processId) {
  const rec = states.get(keyOf(applicationId, processId));
  if (!rec) return getState(applicationId, processId);
  // Group-kill whenever there is a pgid, whatever the status says (FINDINGS B6).
  if (rec.pgid == null && !isActiveStatus(rec.status)) return acknowledgeDead(rec);
  rec.stopRequested = true;
  rec.status = 'stopping';
  rec.finalised = false;
  emitStatus(rec);
  return withLock(keyOf(applicationId, processId), () => terminate(rec));
}

/**
 * Stop then start, waiting for the group to actually die in between — a dev server that restarts
 * before its predecessor releases the port fails in a way that looks like a config error.
 * @param {object} cfg resolved process config plus `applicationId`
 */
export async function restart(cfg) {
  await stop(cfg.applicationId, cfg.id);
  const rec = ensureRecord(cfg.applicationId, cfg.id);
  rec.restarts += 1;
  return start(cfg);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 * @returns {object} RuntimeState — a stopped default for a process we have never run
 */
export function getState(applicationId, processId) {
  const rec = states.get(keyOf(applicationId, processId));
  return publicState(rec ?? newRecord(applicationId, processId));
}

/** @param {string} applicationId @param {string} processId */
export function isActive(applicationId, processId) {
  return isActiveStatus(states.get(keyOf(applicationId, processId))?.status ?? 'stopped');
}

/** Graceful shutdown of everything we still hold a group for. */
export async function stopAll() {
  const live = (rec) => rec.pgid != null || isActiveStatus(rec.status);
  const targets = [...states.values()].filter(live);
  await Promise.all(targets.map((rec) => stop(rec.applicationId, rec.processId)
    .catch((err) => warn(`could not stop ${rec.processId}`, err))));
}

/**
 * Last resort, for `process.on('exit')`: anything asynchronous there is discarded (FINDINGS E3),
 * so this is a synchronous SIGKILL sweep and nothing else.
 */
export function killAllSync() {
  for (const rec of states.values()) {
    clearSettleTimer(rec);
    if (rec.pgid == null) continue;
    killTreeSync(rec.pgid);
  }
}

/** Drop runtime state after its config is deleted; a group still alive is killed, not abandoned. */
export function forget(applicationId, processId) {
  const key = keyOf(applicationId, processId);
  const rec = states.get(key);
  if (!rec) return;
  clearSettleTimer(rec);
  rec.generation += 1;  // orphan every handler still attached to the old child
  rec.forgotten = true;
  resolveSettle(rec);   // an in-flight start() would otherwise wait on a window nothing will end
  if (rec.pgid != null) killGroup(rec.pgid).catch((e) => warn(`could not kill ${processId}`, e));
  states.delete(key);
  locks.delete(key);
  removeRuntimeEntry(rec).catch((err) => warn('could not update the runtime file', err));
}

/**
 * Kill groups left behind by a previous manager run. This is the only cover for `kill -9` of the
 * manager, which nothing in-process can handle (FINDINGS E5).
 * @returns {Promise<object[]>} the records that were killed
 */
export async function reapOrphans() {
  if (!REAP_ORPHANS) return [];
  const { processes } = await readRuntimeFile();
  const reaped = [];
  for (const entry of processes) {
    if (await reapEntry(entry)) reaped.push(entry);
  }
  // Every record belongs to a run that is over: the validated ones are dead, the rest are stale.
  await updateRuntimeFile(() => ({ version: 1, processes: [] }));
  if (reaped.length) {
    console.error(`[paddock] reaped ${reaped.length} orphaned process group(s): ` +
      reaped.map((entry) => entry.pgid).join(', '));
  }
  return reaped;
}
