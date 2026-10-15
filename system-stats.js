/**
 * The machine's own load: CPU, memory and free disk, for the dashboard to show beside the services
 * that are causing it. A dev machine running six dev servers, a database and a bundler in watch mode
 * is usually short on one of the three, and this is how that becomes visible before it becomes a
 * hung build.
 *
 * CPU is a rate, not a level: it only exists as the difference between two readings of the kernel's
 * per-core counters, so the module keeps the previous reading and each sample measures the interval
 * since it. Memory and disk are levels and are simply read.
 */
import fs from 'fs/promises';
import os from 'os';
import * as platform from './platform/index.js';

/**
 * Where repositories, node_modules and package caches land, so the volume that actually fills up.
 * On macOS this is the shared APFS container, so it is the free space Finder reports too.
 */
const DISK_PATH = os.homedir();

/**
 * Two samples closer together than this would measure scheduler noise. A REST read landing just
 * after a stream tick reuses the tick's figure instead.
 */
const MIN_CPU_INTERVAL_MS = 250;

const percentOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1_000) / 10 : null);

/**
 * The per-core counters summed into one machine-wide reading, in milliseconds.
 * @param {os.CpuInfo[]} [cpus]
 * @returns {{idle: number, total: number}}
 */
export function cpuTimes(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/**
 * The busy share of the interval between two readings, across every core, 0–100. Null when the
 * counters did not advance — no interval, nothing to measure.
 * @param {{idle: number, total: number}} previous
 * @param {{idle: number, total: number}} current
 * @returns {number|null}
 */
export function cpuPercent(previous, current) {
  const elapsed = current.total - previous.total;
  if (elapsed <= 0) return null;
  const busy = elapsed - (current.idle - previous.idle);
  return Math.min(100, Math.max(0, percentOf(busy, elapsed)));
}

let cpuBaseline = cpuTimes();
let cpuBaselineAt = Date.now();
let lastCpuPercent = null;

function readCpu() {
  const now = Date.now();
  if (lastCpuPercent !== null && now - cpuBaselineAt < MIN_CPU_INTERVAL_MS) return lastCpuPercent;
  const current = cpuTimes();
  lastCpuPercent = cpuPercent(cpuBaseline, current) ?? lastCpuPercent;
  cpuBaseline = current;
  cpuBaselineAt = now;
  return lastCpuPercent;
}

async function readMemory() {
  try {
    const { total, used } = await platform.memoryUsage();
    return { total, used, percent: percentOf(used, total) };
  } catch {
    return null;
  }
}

/**
 * Free is what an unprivileged user can still write (`bavail`), not `bfree`: the blocks reserved
 * for root are no use to a dev server filling the disk with logs.
 */
async function readDisk() {
  try {
    const { bsize, blocks, bavail } = await fs.statfs(DISK_PATH);
    const total = blocks * bsize;
    const free = bavail * bsize;
    return { path: DISK_PATH, total, used: total - free, free, percent: percentOf(total - free, total) };
  } catch {
    return null;
  }
}

/**
 * One reading of the machine. A part that could not be read is null rather than zero: an empty
 * disk meter would say "plenty of space" about a disk nobody looked at.
 * @returns {Promise<{sampledAt: string,
 *   cpu: {percent: number|null, cores: number, loadAverage: number[]|null},
 *   memory: {total: number, used: number, percent: number}|null,
 *   disk: {path: string, total: number, used: number, free: number, percent: number}|null}>}
 */
export async function sample() {
  const cpuPercentNow = readCpu();
  const [memory, disk] = await Promise.all([readMemory(), readDisk()]);
  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      percent: cpuPercentNow,
      cores: os.availableParallelism(),
      // Windows has no load average; os.loadavg() reports zeros there, which would read as idle.
      loadAverage: platform.platformName === 'win32' ? null : os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    memory,
    disk,
  };
}
