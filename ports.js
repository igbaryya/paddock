/**
 * Listening-port inspection: what is on port 8080, and is it ours? The OS scan is expensive and
 * shared by the dashboard and the agent, so it sits behind one single-flight cache; correlation to
 * a managed process is a pure function over that snapshot plus the manager's runtime state, which
 * is what makes it testable without an operating system.
 *
 * The governing rule is honesty: this module says "we could not tell" far more readily than it
 * guesses. A fabricated association would send a developer to kill the wrong process.
 */
import path from 'path';
import * as platform from './platform/index.js';
import { PORT_SCAN_TTL_MS, PORT_STOP_GRACE_MS } from './config.js';

/** How many port-holding pids may cost a paths lookup; each one is a separate OS call. */
const PATH_LOOKUP_LIMIT = 16;

/** How often the termination path re-checks whether a process has actually gone. */
const DEATH_POLL_MS = 100;

/**
 * Killing any of these breaks the machine or the manager itself. The list is deliberately tiny —
 * a longer one would start refusing legitimate kills, which is the whole feature.
 */
const isProtectedPid = (pid) =>
  !Number.isInteger(pid) ||
  pid <= 1 ||
  pid === process.pid ||
  pid === process.ppid ||
  (platform.platformName === 'win32' && pid === 4);

const isLoopback = (address) =>
  address === '127.0.0.1' || address === '::1' || address.startsWith('127.');

/** A port reachable from outside this machine is the thing a developer wants to notice. */
const isExposed = (address) => address === '0.0.0.0' || address === '::' || !isLoopback(address);

// --- scan cache ------------------------------------------------------------------------------

/** @type {{scannedAt: string, listeners: object[], processes: Map<number, object>, degraded: string[]}|null} */
let cached = null;
/** @type {{startedAt: number, promise: Promise<object>}|null} */
let inFlight = null;

const isFresh = () =>
  cached && Date.now() - Date.parse(cached.scannedAt) < PORT_SCAN_TTL_MS;

async function runScan() {
  const [{ listeners, degraded }, processes] = await Promise.all([
    platform.listListeningPorts(),
    platform.processSnapshot(),
  ]);
  await addProcessPaths(listeners, processes);
  return { scannedAt: new Date().toISOString(), listeners, processes, degraded };
}

/**
 * Working directory and executable cost one OS call per pid, so they are fetched only for pids that
 * actually hold a port and only up to a limit — on a machine with many listeners these lookups
 * would otherwise dominate the scan.
 */
async function addProcessPaths(listeners, processes) {
  const pids = [...new Set(listeners.map((l) => l.pid).filter(Number.isInteger))];
  const wanted = pids.filter((pid) => processes.has(pid)).slice(0, PATH_LOOKUP_LIMIT);
  const found = await Promise.all(wanted.map((pid) => platform.processPaths(pid)));
  wanted.forEach((pid, index) => {
    const proc = processes.get(pid);
    proc.workingDirectory ??= found[index].workingDirectory;
    proc.executablePath ??= found[index].executablePath;
  });
}

/**
 * @param {{force?: boolean}} [options] force skips the TTL, and also refuses to join a scan that
 *   started before this call — otherwise a refresh issued right after a successful stop returns the
 *   pre-stop snapshot and the port still looks held.
 */
export async function scan({ force = false } = {}) {
  const requestedAt = Date.now();
  if (!force && isFresh()) return cached;
  if (inFlight && !(force && inFlight.startedAt < requestedAt)) return inFlight.promise;

  const promise = runScan()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  // A failed scan must neither be cached nor evict the last good snapshot: one transient lsof
  // hiccup would otherwise blank the whole dashboard.
  inFlight = { startedAt: requestedAt, promise };
  return promise;
}

/** The last successful scan, or null before the first — never triggers one. */
export const peek = () => cached;

/** Runtime state changed, so any cached view of who owns what is suspect. */
export const invalidate = () => {
  cached = null;
};

// --- correlation -----------------------------------------------------------------------------

const insideOrEqual = (child, parent) => {
  if (!child || !parent) return false;
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
};

/**
 * Walk pid -> ppid looking for a managed process. Bounded by the map size because a corrupted or
 * recycled parent chain can otherwise form a cycle.
 */
function ancestorMatch(pid, processes, byPid) {
  const seen = new Set();
  let current = processes.get(pid)?.ppid;
  while (Number.isInteger(current) && current > 1 && !seen.has(current)) {
    seen.add(current);
    if (byPid.has(current)) return byPid.get(current);
    current = processes.get(current)?.ppid;
  }
  return null;
}

/**
 * Ordered tiers, first match wins — never additive scoring, which manufactures confidence out of
 * several weak signals. The ranking is measured, not assumed: on POSIX the manager spawns detached,
 * so the pid it holds IS the process group id, and pgid survives both the shell exiting and the
 * listener being reparented to init. Ancestry breaks in exactly that case; pgid does not.
 * @returns {{owner: object}}
 */
function correlateOne(listener, processes, managed, byPid) {
  const proc = processes.get(listener.pid) ?? null;

  const exactPid = byPid.get(listener.pid);
  // `sh -c '<simple command>'` execs in place, so the pid the manager recorded very often IS the
  // listener — exact matches are common here, not the rarity they look like.
  if (exactPid) return owned(exactPid, 'exact');

  // pgid is null on Windows, which has no process groups, and correlation falls to ancestry there.
  if (proc && Number.isInteger(proc.pgid) && byPid.has(proc.pgid)) {
    return owned(byPid.get(proc.pgid), 'exact');
  }

  const ancestor = ancestorMatch(listener.pid, processes, byPid);
  if (ancestor) return owned(ancestor, 'high');

  const byDirectory = managed.filter((m) => insideOrEqual(proc?.workingDirectory, m.repositoryPath));
  if (byDirectory.length === 1) return owned(byDirectory[0], 'medium');
  if (byDirectory.length > 1) return ambiguous(byDirectory, 'medium');

  const byCommand = managed.filter(
    (m) => proc?.commandLine && proc.commandLine.includes(m.repositoryPath)
  );
  if (byCommand.length === 1) return owned(byCommand[0], 'low');
  if (byCommand.length > 1) return ambiguous(byCommand, 'low');

  // Deliberately no name-based tier. There are dozens of `node` processes on a developer's machine
  // and matching on the name would attach an application to an unrelated one.
  return { owner: unmanaged(listener) };
}

const owned = (m, confidence) => ({
  owner: {
    kind: 'managed',
    confidence,
    applicationId: m.applicationId,
    applicationName: m.applicationName,
    processId: m.processId,
    processName: m.processName,
    reason: null,
    candidates: [],
  },
});

/**
 * Two managed processes matched at the same tier — typically two entries sharing a repository. The
 * honest answer is both, not a coin flip: the UI shows the choice and no lifecycle action is
 * offered until the user resolves it.
 */
const ambiguous = (candidates, confidence) => ({
  owner: {
    kind: 'ambiguous',
    confidence,
    applicationId: null,
    applicationName: null,
    processId: null,
    processName: null,
    reason: 'several configured processes match equally well',
    candidates: candidates.map((m) => ({
      applicationId: m.applicationId,
      applicationName: m.applicationName,
      processId: m.processId,
      processName: m.processName,
    })),
  },
});

const unmanaged = (listener) =>
  Number.isInteger(listener.pid)
    ? {
        kind: 'unmanaged',
        confidence: null,
        applicationId: null,
        applicationName: null,
        processId: null,
        processName: null,
        reason: null,
        candidates: [],
      }
    : {
        // The OS reported a socket but not its owner. "Unknown" and "unmanaged" are different
        // answers and collapsing them would tell the user we looked and found nothing.
        kind: 'unknown',
        confidence: null,
        applicationId: null,
        applicationName: null,
        processId: null,
        processName: null,
        reason: 'owner-not-visible',
        candidates: [],
      };

/**
 * Collapse raw socket rows into one entry per (port, pid). A single logical listener appears once
 * per address family and once per source, so without this the dashboard shows every port twice.
 * The set of addresses is kept rather than discarded: `127.0.0.1` versus `0.0.0.0` is exactly the
 * "localhost only" versus "exposed on the network" distinction worth surfacing.
 */
function mergeListeners(listeners) {
  const merged = new Map();
  for (const listener of listeners) {
    const key = `${listener.port}:${listener.pid ?? 'unknown'}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = { port: listener.port, protocol: listener.protocol, pid: listener.pid, addresses: new Set(), name: null };
      merged.set(key, entry);
    }
    if (listener.address) entry.addresses.add(listener.address);
    // lsof's name is the better of the two — netstat truncates to 16 characters.
    if (listener.source === 'lsof' && listener.name) entry.name = listener.name;
    else if (!entry.name && listener.name) entry.name = listener.name;
  }
  return [...merged.values()];
}

/**
 * Pure: snapshot plus configuration in, PortUsage rows out. No OS access, no clock, no I/O — the
 * correlation rules can therefore be tested exhaustively against fabricated snapshots.
 * @param {{listeners: object[], processes: Map<number, object>}} snapshot
 * @param {object[]} managed processes the manager is currently running, with their repository paths
 * @returns {object[]} PortUsage rows, ascending by port
 */
export function correlate(snapshot, managed) {
  const byPid = new Map();
  for (const m of managed) if (Number.isInteger(m.pid)) byPid.set(m.pid, m);

  return mergeListeners(snapshot.listeners)
    .map((listener) => {
      const proc = snapshot.processes.get(listener.pid) ?? null;
      const addresses = [...listener.addresses].sort();
      const { owner } = correlateOne(listener, snapshot.processes, managed, byPid);
      return {
        port: listener.port,
        protocol: listener.protocol,
        addresses,
        exposed: addresses.some(isExposed),
        pid: listener.pid,
        // Every one of these is null when the OS would not say, which is a different statement from
        // an empty string and is rendered differently by the UI.
        processName: proc?.name ?? listener.name ?? null,
        executablePath: proc?.executablePath ?? null,
        commandLine: proc?.commandLine ?? null,
        workingDirectory: proc?.workingDirectory ?? null,
        startedAt: proc?.startedAt ?? null,
        owner,
      };
    })
    .sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

// --- termination -----------------------------------------------------------------------------

/**
 * An identity fingerprint, so a pid that dies and is recycled between resolving it and signalling it
 * cannot absorb the signal meant for its predecessor. Start time alone is not enough: it has
 * one-second granularity on macOS.
 */
const fingerprintOf = (proc) => (proc ? `${proc.startedAt ?? ''}\u0000${proc.commandLine ?? ''}` : null);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-read the pid's identity and compare it with what we resolved. This runs before EVERY signal,
 * including before the force escalation — the grace window is seconds, which is long enough for a
 * pid to die, be reused, and receive a SIGKILL meant for something else. The check looks redundant
 * the second time and is not.
 */
async function identityHolds(pid, fingerprint) {
  const processes = await platform.processSnapshot();
  const current = processes.get(pid);
  if (!current) return false;
  return fingerprintOf(current) === fingerprint;
}

/**
 * Terminate one unmanaged process: verify identity, ask politely, escalate, and confirm. The single
 * pid is signalled, never its group — an unmanaged pid's group may be the user's login shell.
 *
 * Verify-then-signal cannot be made atomic on either platform. The fingerprint narrows the window
 * to microseconds; it does not close it.
 * @param {number} pid
 * @param {string|null} fingerprint from the snapshot the caller resolved the port against
 * @returns {Promise<{stopped: boolean, reason?: string, forced?: boolean}>}
 */
export async function terminate(pid, fingerprint) {
  if (isProtectedPid(pid)) return { stopped: false, reason: 'protected' };
  if (!platform.processExists(pid)) return { stopped: false, reason: 'not-found' };
  if (fingerprint && !(await identityHolds(pid, fingerprint))) {
    return { stopped: false, reason: 'identity-changed' };
  }

  const asked = await platform.signalProcess(pid, { force: false });
  // A refusal that is not "already gone" is the user's answer — usually a process owned by root.
  if (!asked.signalled && asked.reason !== 'not-found') return { stopped: false, reason: asked.reason };

  if (await waitForDeath(pid, PORT_STOP_GRACE_MS)) return { stopped: true, forced: false };

  if (fingerprint && !(await identityHolds(pid, fingerprint))) {
    return { stopped: false, reason: 'identity-changed' };
  }
  const forced = await platform.signalProcess(pid, { force: true });
  if (!forced.signalled && forced.reason !== 'not-found') {
    return { stopped: false, reason: forced.reason };
  }
  if (await waitForDeath(pid, PORT_STOP_GRACE_MS)) return { stopped: true, forced: true };
  return { stopped: false, reason: 'still-running' };
}

async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!platform.processExists(pid)) return true;
    await wait(DEATH_POLL_MS);
  }
  return !platform.processExists(pid);
}

/**
 * Is this port free now? A dead process is not the same as a released port — a sibling may still be
 * listening on it, and reporting success on a port that is still held is exactly the lie this
 * feature exists to prevent.
 * @param {number} port
 */
export async function portHolders(port) {
  const { listeners } = await platform.listListeningPorts();
  return [...new Set(listeners.filter((l) => l.port === port).map((l) => l.pid))];
}

export { fingerprintOf };
