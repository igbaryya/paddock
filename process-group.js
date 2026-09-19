/**
 * Ending a process group, and knowing when it is actually gone.
 *
 * This is shared by everything that spawns something the user can see: a supervised dev server
 * (`process-manager.js`) and an interactive terminal (`terminal-manager.js`). Both spawn a leader
 * that immediately becomes something else — a shell that execs `npm`, a shell that runs whatever
 * is typed at it — so in both cases the group is the only handle that reaches the whole tree, and
 * the group being gone is the only honest definition of "stopped".
 *
 * It holds no state. Callers own their records; this owns the rule that a stop escalates and that
 * a probe, not an event, is what settles it.
 */
import { signalTree, treeAlive } from './platform/index.js';
import { STOP_GRACE_MS } from './config.js';

const GROUP_POLL_MS = 100;
const KILL_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `process.kill(0, …)` addresses the caller's own group, so a probe needs a genuine pid first.
 * @param {unknown} pid
 */
export const usablePid = (pid) => Number.isInteger(pid) && pid > 0;

/**
 * Poll the group until it is gone. The probe — not any child event — is what "stopped" means.
 * @param {number|null} pgid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when the group is confirmed gone
 */
export async function awaitGroupGone(pgid, timeoutMs) {
  if (!usablePid(pgid)) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!treeAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
}

/**
 * SIGTERM, poll, escalate to SIGKILL at the grace deadline, keep polling (FINDINGS B5).
 * @param {number|null} pgid
 * @returns {Promise<boolean>} true when the group is confirmed gone
 */
export async function killGroup(pgid) {
  if (!usablePid(pgid)) return true;
  await signalTree(pgid, { force: false });
  if (await awaitGroupGone(pgid, STOP_GRACE_MS)) return true;
  await signalTree(pgid, { force: true });
  return awaitGroupGone(pgid, KILL_WAIT_MS);
}
