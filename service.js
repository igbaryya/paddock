/**
 * Domain facade — the single API boundary for both the REST layer and the MCP layer. It composes
 * the configuration store, the runtime process manager and the log store, and it is the only place
 * that builds view models, so a human on the dashboard and an agent over MCP can never be looking
 * at divergent shapes of the same application. Nothing above this file talks to those modules
 * directly, which is what keeps process-management logic from being written twice.
 */
import * as applications from './applications.js';
import * as manager from './process-manager.js';
import * as terminals from './terminal-manager.js';
import * as logStore from './log-store.js';
import * as ports from './ports.js';
import * as workspace from './workspace.js';
import * as favicons from './favicons.js';
import * as git from './git.js';
import * as loginItem from './login-item.js';
import * as cluster from './postgres/cluster.js';
import * as lifecycle from './postgres/lifecycle.js';
import * as discovery from './postgres/discovery.js';
import * as pool from './postgres/pool.js';
import * as catalog from './postgres/catalog.js';
import * as admin from './postgres/admin.js';
import { DATA_DIR, MCP_AUTO_CONFIGURE, MCP_PORT_OVERRIDE, ROOT_DIR } from './config.js';
import * as mcpListener from './mcp-listener.js';
import * as mcpPrefs from './mcp-preferences.js';
import * as mcpSessions from './mcp-sessions.js';
import * as mcpAudit from './mcp-audit.js';

/**
 * Re-exported so `http/` never has to reach past this layer for runtime events. PostgreSQL servers
 * report their status and log lines on the same stream, so a dashboard follows both one way.
 */
export const events = manager.events;
for (const name of ['status', 'log']) lifecycle.events.on(name, (event) => events.emit(name, event));

/** An absent workingDirectory means "the repository root" — resolved once, here, for everyone. */
const effectiveCwd = (proc) => proc.workingDirectory || proc.repositoryPath;

/** process-manager is handed a fully resolved config: it never reads the DB and never defaults. */
const spawnConfig = (applicationId, proc) => ({
  ...proc,
  applicationId,
  workingDirectory: effectiveCwd(proc),
});

const isPostgres = (config) => config.kind === 'postgres';

/** A PostgreSQL application is named before its server is defined, and runs nothing until it is. */
const hasServer = (config) => isPostgres(config) && Boolean(config.postgres);

/**
 * What an application runs. A PostgreSQL application's one server is derived from its settings on
 * every read, so views, logs and ports treat it exactly like a configured process.
 * @param {object} config an ApplicationConfig
 */
const processesOf = (config) => {
  if (!isPostgres(config)) return config.processes;
  return hasServer(config) ? [cluster.serverProcess(config)] : [];
};

/**
 * How an application's processes are run, behind one set of calls. A configured process is a child
 * of this manager, supervised by process-manager until its group is gone. A PostgreSQL server is not
 * a child at all: pg_ctl runs it detached, so it outlives Paddock and may be up before Paddock is,
 * and postgres/lifecycle.js observes it rather than holding it — which is why only that runtime has
 * anything to refresh.
 */
const RUNTIMES = {
  processes: {
    refresh: async () => {},
    getState: (config, proc) => manager.getState(config.id, proc.id),
    start: (config, proc) => manager.start(spawnConfig(config.id, proc)),
    stop: (config, proc) => manager.stop(config.id, proc.id),
    restart: (config, proc) => manager.restart(spawnConfig(config.id, proc)),
    forget: (config, proc) => manager.forget(config.id, proc.id),
  },
  postgres: {
    refresh: async (config) => (hasServer(config) ? lifecycle.refresh(cluster.serverOf(config)) : null),
    getState: (config) => lifecycle.getState(config.id),
    start: (config) => lifecycle.start(cluster.serverOf(config)),
    stop: (config) => lifecycle.stop(cluster.serverOf(config)),
    restart: (config) => lifecycle.restart(cluster.serverOf(config)),
    forget: (config) => lifecycle.forget(config.id),
  },
};

const runtimeOf = (config) => (isPostgres(config) ? RUNTIMES.postgres : RUNTIMES.processes);

/** Views are built synchronously, so whatever has to be observed is observed before they are. */
const refreshRuntimes = (configs) => Promise.all(configs.map((config) => runtimeOf(config).refresh(config)));

const findProcess = (config, processId) => {
  const proc = processesOf(config).find((p) => p.id === processId);
  if (proc) return proc;
  throw new applications.NotFoundError(`No process ${processId} in application ${config.id}`);
};

/** Config fields plus the flattened runtime state — the shape UI and agent both consume. */
const processView = (config, proc) => {
  const applicationId = config.id;
  const state = runtimeOf(config).getState(config, proc);
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

/**
 * The settings as configured, plus where they are reached — minus the password, which the manager
 * uses and no view hands out: the application list goes to every dashboard and into agents' context.
 */
const postgresView = ({ password, ...settings }) => ({
  ...settings,
  host: cluster.HOST,
  passwordSet: password !== '',
});

/** @param {object} config an ApplicationConfig */
const applicationView = (config) => {
  const processes = processesOf(config).map((proc) => processView(config, proc));
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    // An application stored before the field existed has none, and that means off.
    autoStart: config.autoStart === true,
    kind: config.kind,
    // Null for a PostgreSQL application too, until its server is defined.
    postgres: hasServer(config) ? postgresView(config.postgres) : null,
    status: applicationStatus(processes),
    // Where the dashboard's canvas left each card. Carried on the view so the canvas reads it from
    // the same list it reads statuses from, rather than needing a request of its own.
    layout: config.layout ?? {},
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    processCounts: processCounts(processes),
    processes,
  };
};

async function viewOf(appId) {
  const config = await applications.getApplication(appId);
  await refreshRuntimes([config]);
  return applicationView(config);
}

/** Runtime state, buffered logs and a cached favicon outlive a deleted config row unless dropped here. */
const discardRuntime = (config, proc) => {
  runtimeOf(config).forget(config, proc);
  logStore.clear(config.id, proc.id);
  favicons.forget(proc.id);
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

async function startOne(config, proc) {
  const runtime = runtimeOf(config);
  try {
    return operationResult(proc, await runtime.start(config, proc), null);
  } catch (err) {
    return operationResult(proc, runtime.getState(config, proc), err);
  }
}

async function stopOne(config, proc) {
  const runtime = runtimeOf(config);
  try {
    await runtime.stop(config, proc);
    return operationResult(proc, runtime.getState(config, proc), null);
  } catch (err) {
    return operationResult(proc, runtime.getState(config, proc), err);
  }
}

/**
 * Has this process ever been spawned in this manager's lifetime? A `crashed` one still counts —
 * FINDINGS B6: its group can outlive the shell that led it, so it is exactly what must be stopped.
 * A PostgreSQL server counts whenever it was seen, whoever started it.
 */
const hasRuntime = (config, proc) => {
  const state = runtimeOf(config).getState(config, proc);
  return state.startedAt != null || state.status !== 'stopped';
};

/**
 * Stop everything the application ever started, newest first. Disabled processes are included:
 * disabling a process in the UI does not kill the group it is already holding.
 * @param {object} config an ApplicationConfig
 */
async function stopProcesses(config) {
  const results = [];
  for (const proc of [...processesOf(config)].reverse()) {
    if (!hasRuntime(config, proc)) continue;
    results.push(await stopOne(config, proc));
  }
  return results;
}

/** @returns {Promise<object[]>} one ApplicationView per configured application */
export async function listApplications() {
  const configs = await applications.listApplications();
  await refreshRuntimes(configs);
  return configs.map(applicationView);
}

/** @param {string} applicationId */
export async function getApplication(applicationId) {
  return viewOf(applicationId);
}

/**
 * @param {{name:string, description?:string, autoStart?:boolean, kind?:'processes'|'postgres',
 *          postgres?:object}} input
 */
export async function createApplication(input) {
  return applicationView(await applications.createApplication(input));
}

/** What the server was started with; credentials only apply to the next connection. */
const SERVER_SETTINGS = ['dataDirectory', 'port', 'binDirectory', 'logFile'];

/**
 * A running server keeps the settings it was started with, like any running process keeps its
 * command — so the same restart marker `updateProcess` sets goes on the server process here.
 */
function markServerChanged(view, patch) {
  const changed = SERVER_SETTINGS.some((key) => patch?.postgres?.[key] !== undefined);
  if (!changed || !lifecycle.isActive(view.id)) return;
  view.processes.find((p) => p.id === cluster.SERVER_PROCESS_ID).configChangedWhileRunning = true;
}

/**
 * @param {string} applicationId
 * @param {{name?:string, description?:string, autoStart?:boolean, postgres?:object}} patch
 */
export async function updateApplication(applicationId, patch) {
  // A server being defined has no earlier settings to be running on, even when it is already up.
  const defined = hasServer(await applications.getApplication(applicationId));
  await applications.updateApplication(applicationId, patch);
  const view = await viewOf(applicationId);
  if (defined) markServerChanged(view, patch);
  return view;
}

/**
 * Where the canvas leaves an application's cards. It answers with the layout alone rather than with
 * an application view: the caller is the canvas that just moved the card and already has the view,
 * and building a new one would refresh every runtime — for a PostgreSQL application, a `pg_ctl
 * status` per drag.
 * @param {string} applicationId
 * @param {Record<string, {x: number, y: number}>} layout
 */
export async function setApplicationLayout(applicationId, layout) {
  return { layout: await applications.setLayout(applicationId, layout) };
}

/**
 * Stops and forgets before deleting: a removed application must not leave live processes that
 * nobody can see or stop. A PostgreSQL server is the exception — it outlives Paddock by design, and
 * deleting its application is Paddock forgetting it, not the server and its clients going down.
 * @param {string} applicationId
 */
export async function deleteApplication(applicationId) {
  const config = await applications.getApplication(applicationId);
  if (!isPostgres(config)) await stopProcesses(config);
  // The config row goes first: discarding runtime is infallible, so a failed write leaves the
  // application intact and still addressable rather than alive but with no state behind it.
  const removed = await applications.deleteApplication(applicationId);
  for (const proc of processesOf(config)) discardRuntime(config, proc);
  await pool.closeApplication(config.id);
  // A terminal outlives the dashboard that opened it, but not the application it was opened in:
  // its directory is one this manager no longer knows anything about.
  await terminals.closeApplication(config.id);
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
  const proc = findProcess(config, processId);
  await stopOne(config, proc);
  await applications.removeProcess(applicationId, processId);
  discardRuntime(config, proc);
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
  for (const proc of processesOf(config).filter((p) => p.enabled)) {
    results.push(await startOne(config, proc));
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

/** Set by `shutdown`, so an auto-start still working through its list stops spawning. */
let shuttingDown = false;

/**
 * Start every application marked to start with Paddock — whether Paddock was started by hand or by
 * the login entry. One application at a time, in configured order, each through the same
 * `startApplication` a click on Start uses, so enabled-only and in-order hold here too.
 *
 * Sequential rather than concurrent: at login several dev servers compiling at once is exactly the
 * spike a machine that is also just waking up handles worst, and two applications that both want
 * port 3000 fail the same way every time instead of whichever loses a race.
 *
 * One application failing — or being deleted from the dashboard mid-way — never stops the rest.
 * @returns {Promise<{applicationId: string, name: string, results: object[], error: string|null}[]>}
 */
export async function autoStartApplications() {
  const configs = (await applications.listApplications()).filter((config) => config.autoStart === true);
  const outcomes = [];
  for (const config of configs) {
    if (shuttingDown) break;
    try {
      const { results } = await startApplication(config.id);
      outcomes.push({ applicationId: config.id, name: config.name, results, error: null });
    } catch (err) {
      outcomes.push({ applicationId: config.id, name: config.name, results: [], error: err.message });
    }
  }
  return outcomes;
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
  await runtimeOf(config).start(config, findProcess(config, processId));
  return viewOf(applicationId);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function stopProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  // Resolved first: a 404 before touching runtime, never a silent no-op.
  await runtimeOf(config).stop(config, findProcess(config, processId));
  return viewOf(applicationId);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 */
export async function restartProcess(applicationId, processId) {
  const config = await applications.getApplication(applicationId);
  await runtimeOf(config).restart(config, findProcess(config, processId));
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
  const processes = processesOf(config);
  const names = new Map(processes.map((p) => [p.id, p.name]));
  const { entries, nextSeq, dropped } = logStore.read({
    applicationId: config.id,
    processIds: proc ? [proc.id] : processes.map((p) => p.id),
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
  // A scan runs every few seconds while a dashboard is open, which is also what notices a server
  // started or stopped from a terminal.
  await refreshRuntimes(configs);
  const managed = [];
  for (const config of configs) {
    for (const proc of processesOf(config)) {
      const state = runtimeOf(config).getState(config, proc);
      if (!Number.isInteger(state.pid)) continue;
      managed.push({
        applicationId: config.id,
        applicationName: config.name,
        processId: proc.id,
        processName: proc.name,
        pid: state.pid,
        repositoryPath: proc.repositoryPath,
        servesHttp: !isPostgres(config),
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
 *
 * A PostgreSQL server is left out: it speaks its own protocol on its port, and an HTTP probe there
 * finds no icon and leaves an "invalid startup packet" line in its log.
 */
function discoverFavicons(owned, managed) {
  const probeable = new Set(
    managed.filter((m) => m.servesHttp).map((m) => portKey(m.applicationId, m.processId))
  );
  const targets = [...owned]
    .filter(([key]) => probeable.has(key))
    .map(([, entry]) => ({
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
  const managed = await managedProcesses();
  const usages = ports.correlate(snapshot, managed);
  const owned = managedListeners(usages);
  rebuildPortIndex(owned);
  discoverFavicons(owned, managed);
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
  const processIds = new Set(configs.flatMap((config) => processesOf(config).map((proc) => proc.id)));
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

// --- PostgreSQL databases --------------------------------------------------------------------

/**
 * Where a PostgreSQL application's server is reached. Asked of any other application it is the
 * caller's mistake, not a missing record, so it is a validation error that names the kind.
 *
 * A server that is not up is refused before connecting: the attempt would only say ECONNREFUSED —
 * or, worse, reach whatever else is listening on that port and answer from the wrong cluster.
 * @param {string} applicationId
 */
async function connectionFor(applicationId) {
  const config = await applications.getApplication(applicationId);
  if (!isPostgres(config)) {
    throw new applications.ValidationError(
      `application '${config.name}' (${config.id}) is not a PostgreSQL application — it has no databases`
    );
  }
  if (!hasServer(config)) {
    throw new applications.ValidationError(
      `the PostgreSQL server of '${config.name}' (${config.id}) is not defined yet — define it in the dashboard first`
    );
  }
  const state = await RUNTIMES.postgres.refresh(config);
  if (state.status !== 'running') {
    throw new applications.ValidationError(
      `the PostgreSQL server of '${config.name}' (${config.id}) is ${state.status} — start it first`
    );
  }
  return cluster.connectionOf(config, state);
}

/** @param {string} applicationId */
export async function clusterInfo(applicationId) {
  return catalog.clusterInfo(await connectionFor(applicationId));
}

/** @param {string} applicationId @param {boolean} [includeTemplates] */
export async function listDatabases(applicationId, includeTemplates = false) {
  return catalog.listDatabases(await connectionFor(applicationId), includeTemplates);
}

/** @param {string} applicationId @param {string} database */
export async function listSchemas(applicationId, database) {
  return catalog.listSchemas(await connectionFor(applicationId), database);
}

/** @param {string} applicationId @param {string} database @param {string} [schema] */
export async function listTables(applicationId, database, schema) {
  return catalog.listTables(await connectionFor(applicationId), database, schema);
}

/** @param {string} applicationId @param {string} database @param {string} table */
export async function describeTable(applicationId, database, table) {
  return catalog.describeTable(await connectionFor(applicationId), database, table);
}

/**
 * Reads only: the statement runs inside a READ ONLY transaction that is always rolled back.
 * @param {{applicationId: string, database: string, sql: string, params?: unknown[]}} q
 */
export async function runReadOnlySql({ applicationId, database, sql, params }) {
  return pool.runReadOnlySql(await connectionFor(applicationId), database, sql, params);
}

/**
 * Writes and DDL, committed — no wrapping transaction.
 * @param {{applicationId: string, database: string, sql: string, params?: unknown[]}} q
 */
export async function runSql({ applicationId, database, sql, params }) {
  return pool.runSql(await connectionFor(applicationId), database, sql, params);
}

/** Past this, a console result is cut off and says so — a grid of a million rows helps nobody. */
const CONSOLE_MAX_ROWS = 1_000;

/** A console request straight from a body: reads unless a write is asked for in so many words. */
function assertStatement(input) {
  const { database, sql, readOnly = true } = input ?? {};
  if (typeof database !== 'string' || database.trim() === '') {
    throw new applications.ValidationError('database must be the name of a database on the server');
  }
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new applications.ValidationError('sql must be a non-empty string');
  }
  if (typeof readOnly !== 'boolean') {
    throw new applications.ValidationError(`readOnly must be true or false, received ${JSON.stringify(readOnly)}`);
  }
  return { database: database.trim(), sql, readOnly };
}

/**
 * One run of a PostgreSQL application's SQL console. Read-only unless `readOnly: false` is sent, and
 * a read-only run takes exactly one statement. Rows come back as arrays beside the column names, so
 * two columns called `id` stay two columns; past CONSOLE_MAX_ROWS the rest are dropped, and
 * `truncated` says so. The whole result is still materialised first — a LIMIT is what keeps a huge
 * table cheap.
 * @param {string} applicationId
 * @param {{database: string, sql: string, readOnly?: boolean}} input
 */
export async function runStatement(applicationId, input) {
  const { database, sql, readOnly } = assertStatement(input);
  const connection = await connectionFor(applicationId);
  const run = readOnly ? pool.runReadOnlySql : pool.runSql;
  const startedAt = performance.now();
  const result = await run(connection, database, sql, [], { rowMode: 'array' });
  return {
    database,
    readOnly,
    command: result.command,
    columns: result.columns,
    rowCount: result.rowCount,
    rows: result.rows.slice(0, CONSOLE_MAX_ROWS),
    truncated: result.rows.length > CONSOLE_MAX_ROWS,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

/** @param {string} applicationId @param {{name: string, owner?: string, template?: string}} input */
export async function createDatabase(applicationId, input) {
  return admin.createDatabase(await connectionFor(applicationId), input);
}

/** @param {string} applicationId @param {string} name */
export async function dropDatabase(applicationId, name) {
  return admin.dropDatabase(await connectionFor(applicationId), { name });
}

/**
 * Clusters on this machine for the PostgreSQL form, each marked with the application that already
 * runs it, if any — a data directory can belong to only one.
 */
export async function discoverClusters() {
  const [found, configs] = await Promise.all([discovery.discover(), applications.listApplications()]);
  const owners = new Map(
    configs.filter(hasServer).map((config) => [config.postgres.dataDirectory, config])
  );
  const clusters = found.map((candidate) => {
    const owner = owners.get(candidate.dataDirectory);
    return { ...candidate, claimedBy: owner ? { id: owner.id, name: owner.name } : null };
  });
  return { clusters };
}

// --- MCP -------------------------------------------------------------------------------------

const effectiveMcpPort = (prefs) => MCP_PORT_OVERRIDE ?? prefs.port;

/**
 * Why the listener is not up, when it should be. Runtime state rather than a preference: it
 * describes this run, and a restart that binds fine must not come up still reporting the old error.
 * @type {{at: string, code: string|null, message: string}|null}
 */
let mcpLastError = null;

const mcpView = async () => {
  const prefs = await mcpPrefs.read();
  const runtime = mcpListener.status();
  const port = effectiveMcpPort(prefs);
  return {
    configured: prefs.configured || MCP_PORT_OVERRIDE !== null,
    enabled: prefs.enabled,
    port,
    portLocked: MCP_PORT_OVERRIDE !== null,
    running: runtime.running,
    boundPort: runtime.port,
    url: runtime.running ? mcpPrefs.mcpUrl(runtime.port) : port ? mcpPrefs.mcpUrl(port) : null,
    lastStartedAt: prefs.lastStartedAt,
    lastStoppedAt: prefs.lastStoppedAt,
    lastError: mcpLastError,
    audit: prefs.audit,
  };
};

/** @returns {Promise<object>} */
export async function getMcp() {
  return mcpView();
}

/**
 * Bind the listener and record the outcome either way: a failure is kept for the view and the
 * audit before it is rethrown, so the dashboard can say why MCP is down instead of just that it is.
 * @param {number} port
 * @param {string} action audit action for a successful bind
 * @returns {Promise<number>} the port actually bound
 */
async function bindMcp(port, action) {
  let bound;
  try {
    bound = await mcpListener.start(port);
  } catch (err) {
    mcpLastError = { at: new Date().toISOString(), code: err.code ?? null, message: err.message };
    await mcpPrefs.update((prefs) => {
      mcpPrefs.appendAudit(prefs, 'start_failed', `port ${port}: ${err.message}`);
      return prefs;
    });
    throw err;
  }
  mcpLastError = null;
  await mcpPrefs.update((prefs) => {
    mcpPrefs.appendAudit(prefs, action, `listening on ${bound}`);
    return { ...prefs, enabled: true, lastStartedAt: new Date().toISOString() };
  });
  console.log(`[paddock] MCP  ${mcpPrefs.mcpUrl(bound)}`);
  return bound;
}

/** Sessions first: an open SSE stream would otherwise hold the listener's close open forever. */
async function unbindMcp() {
  await mcpSessions.closeAll();
  await mcpListener.stop();
}

/**
 * First-run installation: pick a port, mark configured, and start the listener.
 * @param {{port: number}} input
 */
export async function configureMcp(input) {
  const port = mcpPrefs.validatePort(input.port);
  await mcpPrefs.update((prefs) => {
    mcpPrefs.appendAudit(prefs, 'configure', `port ${port}`);
    return { ...prefs, port, configured: true, enabled: true };
  });
  if (mcpListener.status().running) return restartMcp();
  return startMcp();
}

/**
 * One decision, then one action: a port change on a running listener is a restart whether or not
 * the same patch also says `enabled: true`.
 * @param {{port?: number, enabled?: boolean}} patch
 */
export async function updateMcp(patch) {
  if (patch.port !== undefined && MCP_PORT_OVERRIDE !== null) {
    throw new applications.ValidationError(
      'MCP port is locked by PADDOCK_MCP_PORT in the environment'
    );
  }
  if (patch.port !== undefined) mcpPrefs.validatePort(patch.port);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new applications.ValidationError(
      `enabled must be true or false, received ${JSON.stringify(patch.enabled)}`
    );
  }

  await mcpPrefs.update((prefs) => {
    if (patch.port !== undefined) {
      mcpPrefs.appendAudit(prefs, 'port', String(patch.port));
      prefs.port = patch.port;
      prefs.configured = true;
    }
    if (patch.enabled !== undefined) {
      mcpPrefs.appendAudit(prefs, patch.enabled ? 'enable' : 'disable', null);
      prefs.enabled = patch.enabled;
    }
    return prefs;
  });

  const running = mcpListener.status().running;
  if (patch.enabled === false) return stopMcp();
  if (patch.port !== undefined && running) return restartMcp();
  if (patch.enabled === true) return startMcp();
  return mcpView();
}

/** @returns {Promise<object>} */
export async function startMcp() {
  const prefs = await mcpPrefs.read();
  const port = effectiveMcpPort(prefs);
  if (!port || (!prefs.configured && MCP_PORT_OVERRIDE === null)) {
    throw new applications.ValidationError('MCP is not installed — choose a port first');
  }
  if (mcpListener.status().running) return mcpView();
  await bindMcp(port, 'start');
  return mcpView();
}

/** @returns {Promise<object>} */
export async function stopMcp() {
  if (!mcpListener.status().running) return mcpView();
  await unbindMcp();
  await mcpPrefs.update((prefs) => {
    mcpPrefs.appendAudit(prefs, 'stop', null);
    return { ...prefs, enabled: false, lastStoppedAt: new Date().toISOString() };
  });
  return mcpView();
}

/**
 * Stop, then bind the configured port. When that port is taken, the port that was serving a moment
 * ago is bound again, so a bad port change leaves agents where they were rather than cut off — and
 * the error still reaches the caller, since the change they asked for did not happen.
 * @returns {Promise<object>}
 */
export async function restartMcp() {
  const prefs = await mcpPrefs.read();
  const port = effectiveMcpPort(prefs);
  if (!port) throw new applications.ValidationError('MCP is not installed — choose a port first');
  const previous = mcpListener.status().port;
  await unbindMcp();
  try {
    await bindMcp(port, 'restart');
  } catch (err) {
    if (previous && previous !== port) {
      await bindMcp(previous, 'restore').catch(() => {});
    }
    throw err;
  }
  return mcpView();
}

/**
 * Start MCP once the UI server is ready. A fresh install with auto-configure on picks the default
 * port — or any free one, when something else already holds it — and keeps the port it got, so the
 * URL an agent was given stays valid across restarts. A failure is logged and kept for the view:
 * the dashboard has to come up either way.
 */
export async function bootstrapMcp() {
  const prefs = await mcpPrefs.read();
  const installed = prefs.configured || MCP_PORT_OVERRIDE !== null;
  try {
    if (!installed && MCP_AUTO_CONFIGURE) {
      await autoConfigureMcp();
      return;
    }
    if (!installed) return;
    if (!prefs.enabled && MCP_PORT_OVERRIDE === null) return;
    await bindMcp(effectiveMcpPort(prefs), 'start');
  } catch (err) {
    console.error(`[paddock] MCP did not start: ${err.message}`);
  }
}

async function autoConfigureMcp() {
  let bound;
  try {
    bound = await bindMcp(mcpPrefs.DEFAULT_MCP_PORT, 'auto_configure');
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    bound = await bindMcp(0, 'auto_configure');
  }
  await mcpPrefs.update((prefs) => ({ ...prefs, port: bound, configured: true, enabled: true }));
}

// --- MCP sessions and audit ------------------------------------------------------------------
//
// The HTTP layer owns the transports; this layer owns what is known about them. Every change is
// pushed on `events` as `mcp`, so an open dashboard follows who is connected and what they ran
// without polling.

/** @returns {object[]} open sessions, most recently seen first */
export const listMcpSessions = () => mcpSessions.list();

/**
 * @param {{sessionId?: string, tool?: string, limit?: number|string}} [query]
 * @returns {object[]} tool calls, most recent first
 */
export const listMcpCalls = (query = {}) => mcpAudit.list(query);

/**
 * @param {string} id
 * @param {() => Promise<void>} close ends that session's transport
 */
export function openMcpSession(id, close) {
  mcpSessions.open(id, close);
  emitMcpSessions();
}

export const hasMcpSession = (id) => mcpSessions.has(id);

/** @param {string} id @param {{name: string, version: string}|undefined} client */
export function identifyMcpSession(id, client) {
  mcpSessions.identify(id, client);
  emitMcpSessions();
}

export const touchMcpSession = (id) => mcpSessions.touch(id);

/** Called from the transport's own close, whatever ended it. */
export function endMcpSession(id) {
  if (mcpSessions.remove(id)) emitMcpSessions();
}

/**
 * @param {{sessionId: string|null, tool: string, args: unknown, durationMs: number, ok: boolean,
 *          error: string|null}} call
 */
export function recordMcpCall(call) {
  if (call.sessionId) mcpSessions.touch(call.sessionId, { call: true });
  const client = call.sessionId ? mcpSessions.clientOf(call.sessionId) : null;
  const entry = mcpAudit.record({ ...call, client });
  events.emit('mcp', { kind: 'call', call: entry });
}

const emitMcpSessions = () => events.emit('mcp', { kind: 'sessions', sessions: mcpSessions.list() });

// --- settings --------------------------------------------------------------------------------

/**
 * The Settings screen: the start-at-login switch, and the facts about this copy that explain what
 * the switch would start — which checkout, under which node, keeping its data where.
 */
export async function getSettings() {
  return {
    startAtLogin: await loginItem.status(),
    instance: {
      pid: process.pid,
      nodeVersion: process.version,
      nodePath: process.execPath,
      installDir: ROOT_DIR,
      dataDir: DATA_DIR,
    },
  };
}

/**
 * Only the keys sent are changed. Turning the switch on while it is already on rewrites the entry,
 * which is exactly what repairs a stale one.
 * @param {{startAtLogin?: boolean}} patch
 */
export async function updateSettings(patch) {
  const { startAtLogin } = patch;
  if (startAtLogin !== undefined && typeof startAtLogin !== 'boolean') {
    throw new applications.ValidationError(
      `startAtLogin must be true or false, received ${JSON.stringify(startAtLogin)}`
    );
  }
  if (startAtLogin === true) await loginItem.enable();
  if (startAtLogin === false) await loginItem.disable();
  return getSettings();
}

// --- terminals -----------------------------------------------------------------------------

/**
 * Re-exported so the SSE layer can follow one session's output without reaching past this facade,
 * the same reason the runtime emitter is. Kept separate from `events`: a pty emits raw bytes at a
 * rate a `cat` of a large file sets, and the dashboard-wide hub coalesces and fans out to every
 * open tab — a terminal's output belongs to the one client watching it.
 */
export const terminalEvents = terminals.events;

/**
 * Where a terminal may be opened for this application: one entry per distinct directory, each
 * named after a process that runs there.
 *
 * `effectiveCwd` is the same helper the spawn path uses, so a terminal always lands exactly where
 * the dev server would — a process with a `workingDirectory` inside its repository opens there,
 * not at the repository root. Deduped by directory, because two processes sharing one repository
 * are one place to stand, and being asked to choose between identical options is not a choice.
 * @param {object} config an ApplicationConfig
 */
function terminalTargets(config) {
  const byDirectory = new Map();
  for (const proc of processesOf(config)) {
    const cwd = effectiveCwd(proc);
    if (!cwd || byDirectory.has(cwd)) continue;
    byDirectory.set(cwd, { processId: proc.id, processName: proc.name, cwd });
  }
  return [...byDirectory.values()];
}

/**
 * The terminal panel's one read: whether this installation can open a shell, where it may be
 * opened, and what is already open.
 * @param {string} applicationId
 */
export async function listTerminals(applicationId) {
  const config = await applications.getApplication(applicationId);
  return {
    support: await terminals.support(),
    targets: terminalTargets(config),
    sessions: terminals.list(applicationId),
  };
}

/**
 * Open a shell for this application.
 *
 * The caller names a process, never a directory. Resolving it here is the whole security boundary:
 * a request cannot ask for a shell somewhere this application was never registered, which is the
 * same rule that keeps a process's working directory inside its repository. An application with
 * exactly one place to stand may omit the process id — that is the case where the dashboard does
 * not ask.
 * @param {string} applicationId
 * @param {{processId?: string, cols?: number, rows?: number}} input
 */
export async function openTerminal(applicationId, input = {}) {
  const config = await applications.getApplication(applicationId);
  const { available, reason } = await terminals.support();
  if (!available) throw new applications.ValidationError(`cannot open a terminal: ${reason}`);

  const { full, open, limit } = terminals.capacity();
  if (full) {
    throw new applications.ValidationError(
      `${open} terminals are already open, which is the limit (${limit}) — close one first`
    );
  }

  const targets = terminalTargets(config);
  if (targets.length === 0) {
    throw new applications.ValidationError(
      `'${config.name}' has no process to open a terminal in — add one first`
    );
  }
  const target = input.processId
    ? targets.find((candidate) => candidate.processId === input.processId)
    : targets[0];
  if (!target) {
    // Either the id is not this application's, or it names a process whose directory another
    // process was listed for. Both mean "not one of the choices you were given".
    throw new applications.NotFoundError(
      `No terminal target ${input.processId} in application ${config.id}`
    );
  }

  return terminals.open({
    applicationId: config.id,
    processId: target.processId,
    processName: target.processName,
    cwd: target.cwd,
    cols: input.cols,
    rows: input.rows,
  });
}

/** @param {string} sessionId @throws NotFoundError when no session has that id */
const assertTerminal = (sessionId, found) => {
  if (!found) throw new applications.NotFoundError(`No terminal ${sessionId}`);
};

/** @param {string} sessionId @returns {object} the session view */
export function getTerminal(sessionId) {
  const session = terminals.get(sessionId);
  assertTerminal(sessionId, session);
  return session;
}

/** @param {string} sessionId @param {string} data the keystrokes, verbatim */
export function writeTerminal(sessionId, data) {
  if (typeof data !== 'string') {
    throw new applications.ValidationError('data must be a string of input for the terminal');
  }
  assertTerminal(sessionId, terminals.write(sessionId, data));
}

/** @param {string} sessionId @param {number} cols @param {number} rows */
export function resizeTerminal(sessionId, cols, rows) {
  assertTerminal(sessionId, terminals.resize(sessionId, cols, rows));
}

/** @param {string} sessionId */
export async function closeTerminal(sessionId) {
  assertTerminal(sessionId, await terminals.close(sessionId));
}

/**
 * Follow one session. Handed straight through: the SSE layer needs the replay and the live stream
 * as one subscription, and nothing about that is a view this facade should be rebuilding.
 * @param {string} sessionId
 * @param {{onData: (chunk: string) => void, onExit: (event: object) => void}} listener
 * @returns {() => void} unsubscribe
 */
export function followTerminal(sessionId, listener) {
  const unsubscribe = terminals.subscribe(sessionId, listener);
  assertTerminal(sessionId, unsubscribe);
  return unsubscribe;
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

// --- source control --------------------------------------------------------------------------

/**
 * A process's repository, read-only, for the dashboard's Source control tab. Asked of the directory
 * the process runs in — the same one a terminal opens at — and git finds the repository around it.
 *
 * Every git failure is answered as a 400 with git's own words: not a repository, git missing, a
 * repository too slow to read. None of them is Paddock's bug, and a tab that polls every few seconds
 * must not fill the server log with stacks for a machine that simply has no git.
 * @param {string} applicationId @param {string} processId
 * @param {(dir: string) => Promise<object>} ask
 */
async function askGit(applicationId, processId, ask) {
  const proc = findProcess(await applications.getApplication(applicationId), processId);
  try {
    return await ask(effectiveCwd(proc));
  } catch (err) {
    if (err instanceof git.GitError) throw new applications.ValidationError(err.message);
    throw err;
  }
}

/** @param {string} applicationId @param {string} processId */
export const gitStatus = (applicationId, processId) => askGit(applicationId, processId, git.status);

/**
 * @param {string} applicationId @param {string} processId
 * @param {{path: string, staged?: boolean, untracked?: boolean}} file
 */
export const gitDiff = (applicationId, processId, file) =>
  askGit(applicationId, processId, (dir) => git.diff(dir, file));

/** @param {string} applicationId @param {string} processId @param {{limit?: number}} [options] */
export const gitLog = (applicationId, processId, options) =>
  askGit(applicationId, processId, (dir) => git.log(dir, options));

/** Runtime changed, so the cached answer to "who owns this port" is no longer trustworthy. */
manager.events.on('status', () => ports.invalidate());

/**
 * Graceful shutdown: close the database pools, stop following server logs, drain the children, then
 * the log write streams they were all feeding. PostgreSQL servers are not stopped — they are not
 * Paddock's children, and outliving it is what they are run detached for.
 */
export async function shutdown() {
  shuttingDown = true;
  await unbindMcp().catch(() => {});
  await pool.closeAll();
  lifecycle.close();
  // Before the managed processes, and unlike a PostgreSQL server: an open shell is a child of this
  // manager over a pty only it holds, so nothing could reach one it left behind.
  await terminals.closeAll();
  await manager.stopAll();
  // Awaited: closeAll flushes queued JSONL writes, and server.js calls process.exit() right after.
  await logStore.closeAll();
  await mcpAudit.close();
}
