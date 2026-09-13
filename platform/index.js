/**
 * The OS seam. This module picks an implementation from `process.platform` once, at load, and
 * re-exports it under one interface — so `process-manager.js` and everything above it can talk
 * about process trees, signals and shells without a single platform branch. A follow-on feature
 * (listening-port inspection) extends this same interface rather than reaching for an OS utility
 * somewhere else.
 */
import * as posix from './posix.js';
import * as win32 from './win32.js';

const impl = process.platform === 'win32' ? win32 : posix;

/** 'posix' | 'win32' — diagnostics only; behaviour differences belong behind this interface. */
export const platformName = impl.platformName;

/**
 * Argv that runs a user-configured command string through the platform shell.
 * @param {string} command
 * @returns {{file: string, args: string[]}}
 */
export const shellInvocation = impl.shellInvocation;

/**
 * Spawn options that make a child its own killable unit — its own process group on POSIX, a
 * hidden console on Windows. Merge these over the caller's cwd/env/stdio.
 * @param {{cwd?: string, env?: object}} [target] the spawn the options are for; no implementation
 *   needs it today, and it stays in the signature so a future one can without moving every caller
 * @returns {object}
 */
export const spawnOptions = impl.spawnOptions;

/**
 * Signal the whole tree rooted at `pid`. A tree that is already gone is success, not an error.
 * Rejects only when the signal itself failed for a reason the caller should report (POSIX EPERM):
 * a stop that resolves while the group lives on is worse than one that says why it could not.
 * @param {number} pid
 * @param {{force?: boolean}} [options] force picks SIGKILL-equivalent over SIGTERM-equivalent
 * @returns {Promise<void>}
 */
export const signalTree = impl.signalTree;

/**
 * Best-effort force kill of a tree, synchronous and non-throwing, so it is usable from
 * `process.on('exit')` where async work is discarded.
 * @param {number} pid
 */
export const killTreeSync = impl.killTreeSync;

/**
 * Is any member of the tree rooted at `pid` still alive? Never throws. A tree we are not allowed
 * to signal counts as alive — reporting it gone is how a manager ends up lying about its state.
 * @param {number} pid
 * @returns {boolean}
 */
export const treeAlive = impl.treeAlive;

/**
 * Identity fingerprint of `pid`, for validating a persisted spawn record before killing it: pids
 * are recycled, so the orphan reaper matches both fields before signalling anything.
 * @param {number} pid
 * @returns {Promise<{startedAt: string, command: string}|null>}
 */
export const describeLeader = impl.describeLeader;

/**
 * The PATH a user's login shell would give, for the case where the manager was started by a
 * launcher with a minimal environment. Resolves null when unavailable; callers merge it additively.
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
export const loginShellPath = impl.loginShellPath;

/**
 * Every listening TCP socket the OS will report, from whatever sources this platform has. Rows are
 * raw and may duplicate: one logical listener appears once per address family, and the same socket
 * can arrive from two sources. `pid` is null when the OS names a socket but not its owner.
 * `degraded` names any source that returned nothing, so the caller can say the view is partial
 * rather than quietly presenting it as complete.
 * @returns {Promise<{listeners: object[], degraded: string[]}>}
 */
export const listListeningPorts = impl.listListeningPorts;

/**
 * One snapshot of every visible process, keyed by pid. Taken in a single call: per-pid calls give a
 * torn view, where a parent can exit mid-walk. Every field but `pid` is nullable, and null always
 * means "could not determine" — never "none".
 * @returns {Promise<Map<number, {pid, ppid, pgid, startedAt, commandLine, executablePath, name, workingDirectory}>>}
 */
export const processSnapshot = impl.processSnapshot;

/**
 * Working directory and executable path of one pid, best effort. Either may be null, and null means
 * "could not read it": on Windows a working directory is never readable at all, and on POSIX a
 * process we do not own reports nothing.
 * @param {number} pid
 * @returns {Promise<{workingDirectory: string|null, executablePath: string|null}>}
 */
export const processPaths = impl.processPaths;

/**
 * Signal ONE process — never its group. The group is the right target only for processes this
 * manager spawned; for anything else the group may be the user's login shell, and killing it would
 * take down their whole session.
 * @param {number} pid
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{signalled: boolean, reason?: string}>} reason is 'invalid-pid' | 'not-found' |
 *   'permission-denied'; a resolved `signalled` means the signal was delivered, not that the
 *   process died — only a liveness poll can say that.
 */
export const signalProcess = impl.signalProcess;

/**
 * Does this single pid exist? A process we may not signal still exists; reporting it gone is how a
 * manager ends up killing the wrong thing after a pid is recycled.
 * @param {number} pid
 * @returns {boolean}
 */
export const processExists = impl.processExists;

/**
 * Open the operating system's own folder dialog and wait for the user. Only meaningful because the
 * manager serves loopback only: the machine that runs it is the machine whose screen the browser is
 * on. A cancel and a dialog left open past `timeoutMs` are both `cancelled`; `unavailable` means this
 * machine cannot show one at all (no GUI session, no dialog tool) and the caller should offer
 * something else.
 * @param {{startAt: string, prompt: string, timeoutMs: number}} request `startAt` is an existing
 *   absolute directory
 * @returns {Promise<{status: 'picked', path: string} | {status: 'cancelled'} |
 *                   {status: 'unavailable', reason: string}>}
 */
export const pickDirectory = impl.pickDirectory;
