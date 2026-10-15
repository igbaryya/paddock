/**
 * system-stats.js and the platform's memory reading — what the sidebar's CPU, memory and disk
 * meters show.
 *
 * The arithmetic is pinned with fixed inputs, because the failure it guards against is a meter that
 * looks plausible and is wrong: CPU summed over the wrong fields, or macOS memory read from the
 * free-page count, which reports a healthy machine as permanently full.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;

const stats = await import(new URL('../system-stats.js', import.meta.url).href);
const posix = await import(new URL('../platform/posix.js', import.meta.url).href);
const { formatBytes } = await import(new URL('../ui/src/format.js', import.meta.url).href);

const core = (user, sys, idle) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

test('cpuTimes sums every core into one idle and one total', () => {
  assert.deepEqual(stats.cpuTimes([core(100, 50, 850), core(300, 100, 600)]), { idle: 1450, total: 2000 });
});

test('cpuPercent is the busy share of the interval, not of all time', () => {
  const before = { idle: 1_000, total: 2_000 };
  // 1000 ms elapsed across the machine, 250 of it idle.
  assert.equal(stats.cpuPercent(before, { idle: 1_250, total: 3_000 }), 75);
  assert.equal(stats.cpuPercent(before, { idle: 2_000, total: 3_000 }), 0);
  assert.equal(stats.cpuPercent(before, { idle: 1_000, total: 3_000 }), 100);
});

test('cpuPercent with no elapsed time is null rather than a division by zero', () => {
  const same = { idle: 10, total: 20 };
  assert.equal(stats.cpuPercent(same, same), null);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4627.
Pages active:                                 589020.
Pages inactive:                               587646.
Pages speculative:                               622.
Pages throttled:                                   0.
Pages wired down:                             268385.
Pages purgeable:                               19386.
"Translation faults":                     4807361490.
File-backed pages:                            431014.
Anonymous pages:                              746274.
Pages stored in compressor:                  1345161.
Pages occupied by compressor:                 605461.
`;

test('parseVmStat counts app memory, wired and compressed — not the file cache', () => {
  const used = posix.parseVmStat(VM_STAT);
  assert.equal(used, (746274 - 19386 + 268385 + 605461) * 16384);
  // The free-page count would have said 99.98% of 32 GiB is in use; this says about 77%.
  assert.ok(used / 2 ** 35 < 0.8, `expected under 80% of 32 GiB, got ${used}`);
});

test('parseVmStat is null when a field it needs is missing, so the caller can fall back', () => {
  assert.equal(posix.parseVmStat(VM_STAT.replace(/^Anonymous pages:.*$/m, '')), null);
  assert.equal(posix.parseVmStat(''), null);
});

test('memoryUsage reports a used figure within the machine\'s total', async () => {
  const { total, used } = await posix.memoryUsage();
  assert.equal(total, os.totalmem());
  assert.ok(used > 0 && used <= total, `used ${used} of ${total}`);
});

test('a sample carries all three readings, each as a percentage between 0 and 100', async () => {
  const sample = await stats.sample();
  assert.match(sample.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(sample.cpu.cores, os.availableParallelism());
  for (const percent of [sample.cpu.percent, sample.memory.percent, sample.disk.percent]) {
    assert.ok(percent >= 0 && percent <= 100, `out of range: ${percent}`);
  }
  assert.equal(sample.disk.used + sample.disk.free, sample.disk.total);
  assert.equal(sample.disk.path, os.homedir());
});

test('formatBytes uses binary multiples and keeps one decimal below 100', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2 ** 35), '32.0 GB');
  assert.equal(formatBytes(460 * 2 ** 30), '460 GB');
  assert.equal(formatBytes(null), '—');
});
