/**
 * Domain facade — the single API boundary for both the REST layer and the MCP layer. It composes
 * the configuration store, the runtime process manager and the log store, and it is the only place
 * that builds view models, so a human on the dashboard and an agent over MCP can never be looking
 * at divergent shapes of the same application. Nothing above this file talks to those modules
 * directly, which is what keeps process-management logic from being written twice.
 */
import * as applications from './applications.js';
import * as manager from './process-manager.js';
import * as logStore from './log-store.js';
import * as ports from './ports.js';
import * as workspace from './workspace.js';
import * as favicons from './favicons.js';

/** Re-exported so `http/` never has to reach past this layer for runtime events. */
export const events = manager.events;

/** An absent workingDirectory means "the repository root" — resolved once, here, for everyone. */
const effectiveCwd = (proc) => proc.workingDirectory || proc.repositoryPath;

/** process-manager is handed a fully resolved config: it never reads the DB and never defaults. */
const spawnConfig = (applicationId, proc) => ({
  ...proc,
  applicationId,
  workingDirectory: effectiveCwd(proc),
});

const findProcess = (config, processId) => {
  const proc = config.processes.find((p) => p.id === processId);
  if (proc) return proc;
  throw new applications.NotFoundError(`No process ${processId} in application ${config.id}`);
};

/** Config fields plus the flattened runtime state — the shape UI and agent both consume. */
const processView = (applicationId, proc) => {
  const state = manager.getState(applicationId, proc.id);
  return {
    id: proc.id,
    name: proc.name,
    repositoryPath: proc.repositoryPath,
    command: proc.command,
    workingDirectory: effectiveCwd(proc),
    // Only what the user configured: the child's inherited environment is never exposed.
    env: proc.env ?? {},
    enabled: proc.enabled,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    exitCode: state.exitCode,
    exitSignal: state.exitSignal,
    lastError: state.lastError,
    restarts: state.restarts,
    uptimeMs: state.uptimeMs,
    // From the last port scan, never a fresh one: an application list must not block on OS work.
    // `null` means "no scan yet" and `[]` means "scanned, listening on nothing" — different answers.
    ports: portsOf(applicationId, proc.id),
    // Where the icon came from and when, never the image: the bytes are fetched separately, and
    // only by a dashboard that is going to draw them.
    favicon: favicons.describe(proc.id),
  };
};

/**
 * Ports per managed process, keyed `applicationId:processId`. Rebuilt only when a scan completes,
 * so that building a view stays synchronous and an application list never waits on OS work. Null
 * until the first scan.
 * @type {Map<string, number[]>|null}
 */
let portIndex = null;

const portKey = (applicationId, processId) => `${applicationId}:${processId}`;

const portsOf = (applicationId, processId) =>
  portIndex ? portIndex.get(portKey(applicationId, processId)) ?? [] : null;

/**
 * Precedence over the enabled processes only — a disabled process is not part of what the user
 * asked to be running, so an application with none of them is `stopped`, not `failed`.
 * @param {object[]} views
 */
const applicationStatus = (views) => {
  const statuses = views.filter((p) => p.enabled).map((p) => p.status);
  if (statuses.includes('stopping')) return 'stopping';
  if (statuses.includes('starting')) return 'starting';
  if (statuses.length > 0 && statuses.every((s) => s === 'running')) return 'running';
  if (statuses.includes('running')) return 'partial';
  if (statuses.some((s) => s === 'failed' || s === 'crashed')) return 'failed';
  return 'stopped';
};

/** Counts span every process, enabled or not — the sidebar shows `running / enabled`. */
const processCounts = (views) => {
  const counts = { total: views.length, enabled: 0, running: 0, stopped: 0, crashed: 0, failed: 0 };
  for (const p of views) {
    if (p.enabled) counts.enabled += 1;
    if (p.status === 'running') counts.running += 1;
    else if (p.status === 'stopped') counts.stopped += 1;
    else if (p.status === 'crashed') counts.crashed += 1;
    else if (p.status === 'failed') counts.failed += 1;
  }
  return counts;
};

/** @param {object} config an ApplicationConfig */
const applicationView = (config) => {
  const processes = config.processes.map((proc) => processView(config.id, proc));
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    status: applicationStatus(processes),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    processCounts: processCounts(processes),
    processes,
  };
};

const viewOf = async (appId) => applicationView(await applications.getApplication(appId));

/** Runtime state, buffered logs and a cached favicon outlive a deleted config row unless dropped here. */
const discardRuntime = (applicationId, processId) => {
  manager.forget(applicationId, processId);
  logStore.clear(applicationId, processId);
  favicons.forget(processId);
};

/**
 * A start that spawns and dies immediately resolves without throwing, so the resulting status —
 * not the absence of an exception — decides whether the operation succeeded.
 */
const operationResult = (proc, state, error) => ({
  processId: proc.id,
  name: proc.name,
  ok: !error && state.status !== 'crashed' && state.status !== 'failed',
  status: state.status,
  error: error ? error.message : state.lastError,
});

async function startOne(applicationId, proc) {
  try {
    return operationResult(proc, await manager.start(spawnConfig(applicationId, proc)), null);
  } catch (err) {
    return operationResult(proc, manager.getState(applicationId, proc.id), err);
  }
}

async function stopOne(applicationId, proc) {
  try {
    await manager.stop(applicationId, proc.id);
    return operationResult(proc, manager.getState(applicationId, proc.id), null);
  } catch (err) {
    return operationResult(proc, manager.getState(applicationId, proc.id), err);
  }
}

/**
 * Has this process ever been spawned in this manager's lifetime? A `crashed` one still counts —
 * FINDINGS B6: its group can outlive the shell that led it, so it is exactly what must be stopped.
 */
const hasRuntime = (applicationId, processId) => {
  const state = manager.getState(applicationId, processId);
  return state.startedAt != null || state.status !== 'stopped';
};

/**
 * Stop everything the application ever started, newest first. Disabled processes are included:
 * disabling a process in the UI does not kill the group it is already holding.
 * @param {object} config an ApplicationConfig
 */
async function stopProcesses(config) {
  const results = [];
  for (const proc of [...config.processes].reverse()) {
    if (!hasRuntime(config.id, proc.id)) continue;
    results.push(await stopOne(config.id, proc));
  }
  return results;
}

/** @returns {Promise<object[]>} one ApplicationView per configured application */
export async function listApplications() {
  const configs = await applications.listApplications();
  return configs.map(applicationView);
}

/** @param {string} applicationId */
export async function getApplication(applicationId) {
  return viewOf(applicationId);
}

/** @param {{name:string, description?:string}} input */
export async function createApplication(input) {
  return applicationView(await applications.createApplication(input));
}

/**
 * @param {string} applicationId
 * @param {{name?:string, description?:string}} patch
 */
export async function updateApplication(applicationId, patch) {
  await applications.updateApplication(applicationId, patch);
  return viewOf(applicationId);
}

/**
 * Stops and forgets before deleting: a removed application must not leave live processes that
 * nobody can see or stop.
 * @param {string} applicationId
 */
export async function deleteApplication(applicationId) {
  const config = await applications.getApplication(applicationId);
  await stopProcesses(config);
  // The config row goes first: discarding runtime is infallible, so a failed write leaves the
  // application intact and still addressable rather than alive but with no state behind it.
  const removed = await applications.deleteApplication(applicationId);
  for (const proc of config.processes) discardRuntime(config.id, proc.id);
  return applicationView(removed);
}

/**
 * @param {string} applicationId
 * @param {{name:string, repositoryPath:string, command:string, workingDirectory?:string,
 *          env?:object, enabled?:boolean}} input
 */
export async function addProcess(applicationId, input) {
  await applications.addProcess(applicationId, input);
  return viewOf(applicationId);
}

/**
 * Configuration and runtime stay separate — a running child keeps the command it was spawned with
 * until the user restarts it, so the view carries a marker the UI turns into a restart prompt.
 * @param {string} applicationId
 * @param {string} processId
 * @param {object} patch partial process input
 */
export async function updateProcess(applicationId, processId, patch) {
  await applications.updateProcess(applicationId, processId, patch);
  const view = await viewOf(applicationId);
  const updated = view.processes.find((p) => p.id === processId);
  if (updated && manager.isActive(applicationId, processId)) {
    updated.configChangedWhileRunning = true;
  }
  return view;
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function removeProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  await stopOne(config.id, findProcess(config, processId));
  await applications.removeProcess(applicationId, processId);
  discardRuntime(config.id, processId);
  return viewOf(applicationId);
}

/**
 * Enabled processes only, in configured array order, sequentially — an app whose web server
 * expects its api to be up relies on that order. One failure never aborts the rest.
 * @param {string} applicationId
 * @returns {Promise<{application:object, results:object[]}>}
 */
export async function startApplication(applicationId) {
  const config = await applications.getApplication(applicationId);
  const results = [];
  for (const proc of config.processes.filter((p) => p.enabled)) {
    results.push(await startOne(config.id, proc));
  }
  // Re-read rather than reuse `config`: every start above is an await a concurrent edit fits in.
  return { application: await viewOf(applicationId), results };
}

/**
 * @param {string} applicationId
 * @returns {Promise<{application:object, results:object[]}>}
 */
export async function stopApplication(applicationId) {
  const config = await applications.getApplication(applicationId);
  const results = await stopProcesses(config);
  return { application: await viewOf(applicationId), results };
}

/** Everything stops before anything starts — two copies of a dev server fight over the port. */
export async function restartApplication(applicationId) {
  await stopApplication(applicationId);
  return startApplication(applicationId);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function startProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  await manager.start(spawnConfig(config.id, findProcess(config, processId)));
  return viewOf(applicationId);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function stopProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  findProcess(config, processId);   // 404 before touching runtime, never a silent no-op
  await manager.stop(config.id, processId);
  return viewOf(applicationId);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function restartProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  await manager.restart(spawnConfig(config.id, findProcess(config, processId)));
  return viewOf(applicationId);
}

/**
 * Reads the application's buffers, or one process's, and resolves names here so an agent never
 * needs a second call to find out which process a line came from.
 * @param {{applicationId:string, processId?:string, limit?:number, sinceSeq?:number,
 *          stream?:'stdout'|'stderr'}} q
 */
export async function readLogs({ applicationId, processId, limit, sinceSeq, stream }) {
  const config = await applications.getApplication(applicationId);
  const proc = processId ? findProcess(config, processId) : null;
  const names = new Map(config.processes.map((p) => [p.id, p.name]));
  const { entries, nextSeq, dropped } = logStore.read({
    applicationId: config.id,
    processIds: proc ? [proc.id] : config.processes.map((p) => p.id),
    limit,
    sinceSeq,
    stream,
  });
  return {
    application: { id: config.id, name: config.name },
    process: proc ? { id: proc.id, name: proc.name } : null,
    entries: entries.map((entry) => ({
      seq: entry.seq,
      ts: entry.ts,
      stream: entry.stream,
      processId: entry.processId,
      processName: names.get(entry.processId) ?? null,
      message: entry.message,
    })),
    nextSeq,
    dropped,
  };
}

// --- listening ports -------------------------------------------------------------------------

/**
 * Every managed process that currently has a live pid, flattened for the correlator. On POSIX that
 * pid is the process group id, which is what makes a dev server identifiable even after the shell
 * that started it has gone.
 */
async function managedProcesses() {
  const configs = await applications.listApplications();
  const managed = [];
  for (const config of configs) {
    for (const proc of config.processes) {
      const state = manager.getState(config.id, proc.id);
      if (!Number.isInteger(state.pid)) continue;
      managed.push({
        applicationId: config.id,
        applicationName: config.name,
        processId: proc.id,
        processName: proc.name,
        pid: state.pid,
        repositoryPath: proc.repositoryPath,
      });
    }
  }
  return managed;
}

/**
 * The listeners each managed process holds, grouped by process. Only a correlation strong enough to
 * state as fact: a medium-confidence guess still appears in the ports table, where it is labelled as
 * one, but on a process row it would read as certainty — and favicon discovery would be sending
 * requests to a service that may not be ours.
 * @returns {Map<string, {applicationId: string, processId: string,
 *                        listeners: {port: number, addresses: string[]}[]}>}
 */
function managedListeners(usages) {
  const owned = new Map();
  for (const usage of usages) {
    const { kind, confidence, applicationId, processId } = usage.owner;
    if (kind !== 'managed' || (confidence !== 'exact' && confidence !== 'high')) continue;
    const key = portKey(applicationId, processId);
    if (!owned.has(key)) owned.set(key, { applicationId, processId, listeners: [] });
    owned.get(key).listeners.push({ port: usage.port, addresses: usage.addresses });
  }
  return owned;
}

/** Rebuilt whenever a scan lands, so `processView` can read it without awaiting anything. */
function rebuildPortIndex(owned) {
  const index = new Map();
  for (const [key, { listeners }] of owned) {
    index.set(key, listeners.map((listener) => listener.port).sort((a, b) => a - b));
  }
  portIndex = index;
}

/**
 * A scan is the moment a process is known to be serving something, so it is when favicons are
 * looked for. Never awaited: `stopPort` and `getPort` scan too, and neither may wait on a dev server
 * answering HTTP. A newly found icon changes the application views, which is what the
 * `applications` event tells every dashboard to refetch.
 */
function discoverFavicons(owned) {
  const targets = [...owned.values()].map((entry) => ({
    ...entry,
    startedAt: manager.getState(entry.applicationId, entry.processId).startedAt,
  }));
  favicons
    .discover(targets)
    .then((changed) => {
      if (changed) events.emit('applications', { reason: 'favicon' });
    })
    .catch((err) => console.error('[paddock] favicon discovery failed:', err.message));
}

/**
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{scannedAt: string, ports: object[], degraded: string[]}>}
 */
export async function listPorts({ force = false } = {}) {
  const snapshot = await ports.scan({ force });
  const usages = ports.correlate(snapshot, await managedProcesses());
  const owned = managedListeners(usages);
  rebuildPortIndex(owned);
  discoverFavicons(owned);
  return { scannedAt: snapshot.scannedAt, ports: usages, degraded: snapshot.degraded };
}

// --- favicons ----------------------------------------------------------------------------------

/** What earlier runs found, loaded before the first view is built so the first render has icons. */
export const loadFavicons = () => favicons.load();

/**
 * Every cached icon, as data URLs keyed by process id — the overview grid's one request for all of
 * them. Filtered to processes that still exist, so a cache entry a crash left behind never shows.
 */
export async function listFavicons() {
  const configs = await applications.listApplications();
  const processIds = new Set(configs.flatMap((config) => config.processes.map((proc) => proc.id)));
  return { favicons: favicons.list(processIds) };
}

/**
 * One port. Returns `null` for `usage` rather than throwing when nothing is listening — "nothing is
 * on 8080" is an answer, not an error, and it is the answer the caller most often wants.
 * @param {number} port
 */
export async function getPort(port) {
  assertPort(port);
  const { scannedAt, ports: usages, degraded } = await listPorts({ force: true });
  const matches = usages.filter((usage) => usage.port === port);
  return { port, scannedAt, degraded, usages: matches };
}

/**
 * Stop whatever currently holds a port. The caller names a port, never a pid: resolving the owner
 * is the server's job, and it re-resolves immediately before acting so a stale pid from a previous
 * scan can never be the thing that gets signalled.
 *
 * A managed process is routed back through its own lifecycle rather than signalled directly.
 * Signalling it would kill the listener instead of its process group, race the per-process lock,
 * and make the manager report a user-requested stop as a crash.
 * @param {number} port
 */
export async function stopPort(port) {
  assertPort(port);
  const snapshot = await ports.scan({ force: true });
  const usages = ports.correlate(snapshot, await managedProcesses());
  const holders = usages.filter((usage) => usage.port === port);
  if (holders.length === 0) return { port, stopped: false, reason: 'nothing-listening', results: [] };

  const results = [];
  for (const usage of holders) {
    results.push(await stopHolder(usage, snapshot));
  }
  ports.invalidate();
  // The pid being dead is not the port being free: a sibling process may still be listening, and
  // reporting success on a port that is still held is the exact failure this feature exists to fix.
  const remaining = await ports.portHolders(port);
  return {
    port,
    stopped: results.every((r) => r.stopped) && remaining.length === 0,
    portReleased: remaining.length === 0,
    stillHeldBy: remaining,
    results,
  };
}

async function stopHolder(usage, snapshot) {
  const { owner } = usage;
  const describe = { pid: usage.pid, processName: usage.processName, owner: owner.kind };

  if (owner.kind === 'managed' && (owner.confidence === 'exact' || owner.confidence === 'high')) {
    await stopProcess(owner.applicationId, owner.processId);
    return { ...describe, stopped: true, via: 'process-manager', processId: owner.processId };
  }
  if (owner.kind === 'ambiguous') {
    // Two configured processes match equally well. Picking one could stop the wrong dev server, and
    // signalling the pid directly would corrupt whichever one it really is.
    return { ...describe, stopped: false, via: 'none', reason: 'ambiguous-owner' };
  }
  if (!Number.isInteger(usage.pid)) {
    return { ...describe, stopped: false, via: 'none', reason: 'owner-not-visible' };
  }
  const fingerprint = ports.fingerprintOf(snapshot.processes.get(usage.pid));
  const outcome = await ports.terminate(usage.pid, fingerprint);
  return { ...describe, via: 'signal', ...outcome };
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new applications.ValidationError(`port must be an integer between 1 and 65535, received ${port}`);
  }
}

// --- workspace inspection --------------------------------------------------------------------

/**
 * All of these are pass-throughs, and deliberately so: what the process form is allowed to read off
 * the user's disk is one module's decision, and nothing above this facade reaches past it to ask.
 * @param {string} [startAt] where the OS folder dialog opens; anything unusable opens it at home
 */
export const pickDirectory = (startAt) => workspace.pickDirectory(startAt);

/** @param {string} [directory] absolute path; unset opens at the user's home directory */
export const listDirectory = (directory) => workspace.listDirectory(directory);

/** @param {string} directory absolute path — the directory the command will actually run in */
export const inspectDirectory = (directory) => workspace.inspect(directory);

/** Runtime changed, so the cached answer to "who owns this port" is no longer trustworthy. */
manager.events.on('status', () => ports.invalidate());

/** Graceful shutdown: drain the children first, then the log write streams they were feeding. */
export async function shutdown() {
  await manager.stopAll();
  // Awaited: closeAll flushes queued JSONL writes, and server.js calls process.exit() right after.
  await logStore.closeAll();
}
