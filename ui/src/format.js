/**
 * How a process's runtime state is put into words. One copy of each, because a card on the canvas
 * and the drawer detailing that same card must never disagree about how long it has been up.
 */

/** A process being brought up is already burning wall-clock time, so it counts as up. */
export const ALIVE = new Set(['starting', 'running', 'stopping']);

/** @param {number|null} ms */
export const formatUptime = (ms) => {
  // `null` before the first start, and NaN if `startedAt` is ever unparseable — neither is a number
  // of seconds, and printing "NaNs" in a status line is worse than printing nothing.
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1_000);
  const [d, h, m, s] = [Math.floor(total / 86_400), Math.floor(total / 3_600) % 24,
    Math.floor(total / 60) % 60, total % 60];
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
};

/**
 * While the process is alive its uptime is derived from the clock, so it keeps counting between
 * refetches instead of freezing at whatever the last one said.
 * @param {object} process a ProcessView @param {number} now
 */
export const uptimeOf = (process, now) =>
  ALIVE.has(process.status) && process.startedAt
    ? now - Date.parse(process.startedAt)
    : process.uptimeMs;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Binary multiples under the familiar names, the way the OS's own monitor and Finder label memory.
 * @param {number|null} bytes
 */
export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
};

/** @param {object} process a ProcessView @returns {string|null} null when it never exited */
export const exitSummary = (process) => {
  if (process.exitSignal) return `exit on ${process.exitSignal}`;
  if (process.exitCode != null) return `exit ${process.exitCode}`;
  return null;
};
