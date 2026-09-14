/**
 * What a PostgreSQL data directory says about itself, read straight off its files. The server keeps
 * postmaster.pid current for as long as it runs — pg_ctl itself decides "is it running?" from this
 * file — so it answers for a server started by Paddock, by a terminal, or by a Paddock that has since
 * restarted, all the same way.
 *
 * postmaster.pid, one value per line (PostgreSQL 10+): pid, data directory, start time in epoch
 * seconds, port, socket directory, listen address, shared memory key, status.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { processExists } from '../platform/index.js';

const DEFAULT_PORT = 5432;

/** The status line's words, as the process statuses the rest of Paddock uses. */
const PHASES = { starting: 'starting', ready: 'running', standby: 'running', stopping: 'stopping' };

/** A port line anywhere in a config file; the last one wins, as it does for the server. */
const PORT_SETTING = /^\s*port\s*=\s*'?(\d+)'?/gm;

const readText = (file) => fs.readFile(file, 'utf8').catch(() => null);

/**
 * @param {string} dataDirectory
 * @returns {Promise<{running: true, pid: number, port: number|null, startedAt: string|null,
 *                    phase: 'starting'|'running'|'stopping'} | {running: false, stale: boolean}>}
 *   `stale` is a postmaster.pid whose process is gone: the server did not shut down cleanly
 */
export async function inspect(dataDirectory) {
  const text = await readText(path.join(dataDirectory, 'postmaster.pid'));
  if (!text) return { running: false, stale: false };
  const lines = text.split('\n');
  const pid = Number(lines[0]);
  if (!processExists(pid)) return { running: false, stale: true };
  const epoch = Number(lines[2]);
  return {
    running: true,
    pid,
    port: Number(lines[3]) || null,
    startedAt: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1_000).toISOString() : null,
    // A server older than 10 writes no status line, and one that wrote a pid file is up.
    phase: PHASES[lines[7]?.trim()] ?? 'running',
  };
}

/** @returns {Promise<string|null>} the major version that created the cluster, null if it is not one */
export async function readVersion(dataDirectory) {
  const text = await readText(path.join(dataDirectory, 'PG_VERSION'));
  return text?.trim() || null;
}

/**
 * The port a stopped cluster would start on. postgresql.auto.conf is what ALTER SYSTEM writes, and
 * the server reads it after postgresql.conf, so a port there wins.
 * @returns {Promise<number>}
 */
export async function configuredPort(dataDirectory) {
  for (const name of ['postgresql.auto.conf', 'postgresql.conf']) {
    const settings = [...((await readText(path.join(dataDirectory, name))) ?? '').matchAll(PORT_SETTING)];
    if (settings.length) return Number(settings.at(-1)[1]);
  }
  return DEFAULT_PORT;
}
