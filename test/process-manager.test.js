/**
 * Regression suite for process-manager.js, run against REAL processes.
 *
 * The product's core claim is that it knows the true state of a process TREE, so almost nothing
 * here is mocked: every test spawns a real `/bin/sh`, most of them background a real grandchild
 * holding a real TCP port, and the assertions probe the operating system directly
 * (`process.kill(-pgid, 0)`, binding the port) rather than trusting the manager's own report.
 *
 * Hermetic: PADDOCK_DATA_DIR is a fresh temp directory set before the first import of any project
 * module (config.js reads the environment at import time), every port is an ephemeral one the
 * fixture picks and prints, and every process group this file creates is asserted gone in `after`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// --- environment, before anything imports config.js ------------------------------------------

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));

process.env.PADDOCK_DATA_DIR = DATA_DIR;
// Point the .env loader at a file that does not exist, so a developer's real .env cannot reach in.
process.env.PADDOCK_ENV_FILE = path.join(DATA_DIR, 'absent.env');
// Small enough to keep the suite fast, large enough that the escalation is unambiguously measurable.
process.env.PADDOCK_STOP_GRACE_MS = '700';
process.env.PADDOCK_START_SETTLE_MS = '1000';
process.env.PADDOCK_REAP_ORPHANS = 'false';
// Without SHELL, loginShellPath() returns null immediately instead of sourcing the developer's
// interactive rc files (measured at ~540 ms, and not hermetic) on the first spawn.
delete process.env.SHELL;

const pm = await import('../process-manager.js');
const logStore = await import('../log-store.js');

const STOP_GRACE_MS = 700;
const START_SETTLE_MS = 1_000;

// --- fixtures --------------------------------------------------------------------------------

const FIXTURE_DIR = path.join(DATA_DIR, 'fixtures');
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const fixture = (name, contents) => {
  const file = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(file, contents, { mode: 0o755 });
  return file;
};

/** A grandchild that holds an ephemeral TCP port and prints it, so the test can probe the port. */
const PORT_HOLDER = fixture('port-holder.cjs', `
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
`);

/** Same, but it takes 400 ms to die after SIGTERM: resolving on 'exit' would be visibly early. */
const SLOW_TERM_HOLDER = fixture('slow-term-holder.cjs', `
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 400); });
`);

/** Ignores SIGTERM entirely — only a SIGKILL to the group can clear it. */
const STUBBORN_HOLDER = fixture('stubborn-holder.cjs', `
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
`);

/** Shell stays alive; the port is held by a grandchild, unreachable by killing the direct child. */
const GROUP_PORT_SH = fixture('group-port.sh', `#!/bin/sh
node "$HOLDER" &
wait
`);

/** Shell exits immediately while the grandchild lives on, still holding its port. */
const LINGER_SH = fixture('linger.sh', `#!/bin/sh
node "$HOLDER" &
exit 0
`);

/** Nothing in this tree answers SIGTERM. */
const STUBBORN_SH = fixture('stubborn.sh', `#!/bin/sh
trap '' TERM
node "$HOLDER" &
wait
`);

/** Records one line per spawn, so "exactly one process" is a fact on disk, not an inference. */
const COUNTED_SH = fixture('counted.sh', `#!/bin/sh
echo spawned >> "$COUNT_FILE"
sleep 30
`);

/** One plain line, one line split across two writes, one final line with no trailing newline. */
const LOGGING_SH = fixture('logging.sh', `#!/bin/sh
echo first-line
printf 'split-'
sleep 0.3
printf 'part\\n'
printf 'tail-no-newline'
`);

// --- helpers ---------------------------------------------------------------------------------

/** Every pgid this file has ever seen, so `after` can prove none of them outlived the suite. */
const seenPgids = new Set();

const makeCfg = (applicationId, id, command, env = {}) => ({
  applicationId,
  id,
  name: id,
  repositoryPath: FIXTURE_DIR,
  command,
  workingDirectory: null,
  env,
  enabled: true,
});

/**
 * The group probe, written here rather than imported, so the assertions do not depend on the same
 * function the product uses to decide it is done. EPERM means alive but not ours to signal.
 */
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const portFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll rather than sleep, and say what we were waiting for when the deadline passes. */
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) assert.fail(`${message} (still false after ${timeoutMs}ms)`);
    await sleep(50);
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} — timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Wait for a log line from one process matching `pattern`; returns the match. */
function waitForLogLine(applicationId, processId, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pm.events.off('log', onLog);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no log line matching ${pattern} from ${processId} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onLog = (entry) => {
      if (entry.applicationId !== applicationId || entry.processId !== processId) return;
      const match = pattern.exec(entry.message);
      if (!match) return;
      cleanup();
      resolve(match);
    };
    pm.events.on('log', onLog);
  });
}

/** Start `cfg` and resolve with the ephemeral port its grandchild printed. */
async function startHoldingPort(cfg, timeoutMs = 15_000) {
  const [state, match] = await Promise.all([
    withTimeout(pm.start(cfg), timeoutMs, `start(${cfg.id}) never settled`),
    waitForLogLine(cfg.applicationId, cfg.id, /^PORT (\d+)$/, timeoutMs),
  ]);
  const pgid = pm.getState(cfg.applicationId, cfg.id).pid;
  if (pgid != null) seenPgids.add(pgid);
  return { port: Number(match[1]), pgid, state };
}

/**
 * The manager's runtime-file writes are fire-and-forget, so one can land between the walk and the
 * rmdir and recreate the directory. Retry rather than fail a green run on a cleanup race.
 */
async function removeDataDir(attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rm(DATA_DIR, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(100);
    }
  }
  return !fs.existsSync(DATA_DIR);
}

const stdoutMessages = (applicationId, processId) =>
  logStore
    .read({ applicationId, processIds: [processId], limit: 1_000 })
    .entries.filter((entry) => entry.stream === 'stdout')
    .map((entry) => entry.message);

// --- lifecycle -------------------------------------------------------------------------------

before(() => {
  // A handful of tests subscribe at once; the default cap of 10 would print spurious warnings.
  pm.events.setMaxListeners(50);
});


after(async () => {
  await withTimeout(pm.stopAll(), 30_000, 'stopAll() never settled');
  await logStore.closeAll();

  // A leaked fixture would hold a port and poison every later run, so name the survivors and only
  // then clean up after them.
  const survivors = [...seenPgids].filter(groupAlive);
  for (const pgid of survivors) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone between the probe and here — nothing to do.
    }
  }
  const removed = await removeDataDir();

  assert.deepEqual(survivors, [], 'process groups were still alive after stopAll()');
  assert.equal(removed, true, `the temp data directory ${DATA_DIR} could not be removed`);
});

// --- tests -----------------------------------------------------------------------------------

test('stop kills the whole process group, not just the direct child', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_group', 'proc_group', `sh '${GROUP_PORT_SH}'`, { HOLDER: PORT_HOLDER });

  const { port, pgid } = await startHoldingPort(cfg);

  assert.equal(pm.getState(cfg.applicationId, cfg.id).status, 'running');
  assert.equal(typeof pgid, 'number');
  assert.equal(groupAlive(pgid), true, 'the group should be alive while the process is running');
  assert.equal(await portFree(port), false, `port ${port} should be held by the grandchild`);

  const stopped = await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');

  // Killing only the direct child would leave the grandchild — and the port — behind.
  assert.equal(groupAlive(pgid), false, `process group ${pgid} survived stop()`);
  assert.equal(await portFree(port), true, `port ${port} was still held after stop()`);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null, 'the pgid is released once the group is confirmed gone');
  assert.equal(stopped.lastError, null);
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), false);
});

test('stop resolves only once the group is actually gone, not when the child exits', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_linger', 'proc_linger', `sh '${LINGER_SH}'`, { HOLDER: SLOW_TERM_HOLDER });

  // The shell exits at once; the grandchild holding the port outlives it.
  const { port, pgid } = await startHoldingPort(cfg);

  const before = pm.getState(cfg.applicationId, cfg.id);
  assert.notEqual(before.status, 'stopped', 'the child exited but its group still holds a port');
  assert.equal(before.status, 'crashed');
  assert.equal(before.exitCode, 0);
  assert.equal(before.pid, pgid, 'the pgid must be retained while the group is alive (FINDINGS B6)');
  assert.match(String(before.lastError), /still running/);
  assert.equal(groupAlive(pgid), true);
  assert.equal(await portFree(port), false, `port ${port} should still be held`);

  const startedAt = Date.now();
  const stopped = await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');
  const elapsed = Date.now() - startedAt;

  assert.equal(groupAlive(pgid), false, `process group ${pgid} survived stop()`);
  assert.equal(await portFree(port), true, `port ${port} was still held after stop()`);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  // The grandchild takes 400 ms to die after SIGTERM; the child's 'exit' fired long before stop()
  // was even called, so anything faster than that means stop() did not wait for the group.
  assert.ok(elapsed >= 300, `stop() returned after ${elapsed}ms, before the group could have died`);
});

test('a SIGTERM-ignoring tree is escalated to SIGKILL', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_stubborn', 'proc_stubborn', `sh '${STUBBORN_SH}'`, {
    HOLDER: STUBBORN_HOLDER,
  });

  const { port, pgid } = await startHoldingPort(cfg);
  assert.equal(groupAlive(pgid), true);

  const startedAt = Date.now();
  const stopped = await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');
  const elapsed = Date.now() - startedAt;

  assert.equal(groupAlive(pgid), false, `SIGTERM-ignoring group ${pgid} survived stop()`);
  assert.equal(await portFree(port), true, `port ${port} was still held after stop()`);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  // Nothing in this tree answers SIGTERM, so the only way it died is the escalation at the grace
  // deadline — which also means stop() cannot have finished before that deadline.
  assert.ok(
    elapsed >= STOP_GRACE_MS,
    `stop() returned after ${elapsed}ms, sooner than the ${STOP_GRACE_MS}ms grace period`,
  );
  assert.ok(elapsed < STOP_GRACE_MS + 5_000, `escalation took ${elapsed}ms, far past the grace period`);
});

test('a command that exits non-zero during startup is crashed, with its code and stderr recorded', { timeout: 20_000 }, async () => {
  const cfg = makeCfg('app_crash', 'proc_crash', 'printf "boom-from-stderr\\n" >&2; exit 7');

  const state = await withTimeout(pm.start(cfg), 15_000, 'start() of a crashing command never settled');

  assert.equal(state.status, 'crashed');
  assert.equal(state.exitCode, 7);
  assert.equal(state.exitSignal, null);
  assert.match(String(state.lastError), /exited with code 7 during startup/);
  assert.match(String(state.lastError), /boom-from-stderr/);
  assert.equal(state.pid, null, 'the group is gone, so the pgid is released');
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), false);
});

test('a command that exits 0 after settling is stopped, not crashed', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_clean', 'proc_clean', 'sleep 1.6; exit 0');

  const running = await withTimeout(pm.start(cfg), 15_000, 'start() never settled');
  assert.equal(running.status, 'running', 'it must survive the settle window before it can exit "late"');

  await waitUntil(
    () => pm.getState(cfg.applicationId, cfg.id).status !== 'running',
    15_000,
    'the process exited but the manager still reports it running',
  );

  const state = pm.getState(cfg.applicationId, cfg.id);
  assert.equal(state.status, 'stopped');
  assert.equal(state.exitCode, 0);
  assert.equal(state.exitSignal, null);
  assert.match(String(state.lastError), /exited cleanly without being asked to stop/);
  assert.equal(state.pid, null);
});

test('a non-existent working directory fails naming the directory, not the shell, and does not hang', { timeout: 20_000 }, async () => {
  const missing = path.join(DATA_DIR, 'no-such-repository');
  const cfg = makeCfg('app_badcwd', 'proc_badcwd', 'echo never-runs');
  cfg.repositoryPath = missing;

  // 'error' is terminal and 'exit' never follows it (FINDINGS C1), so a manager that waits on
  // 'exit' would hang here forever — the timeout is the assertion.
  await assert.rejects(
    () => withTimeout(pm.start(cfg), 10_000, 'start() on a missing working directory never settled'),
    (err) => {
      assert.ok(
        err.message.includes(missing),
        `the error should name the directory; got: ${err.message}`,
      );
      assert.doesNotMatch(err.message, /\/bin\/sh/, 'the error must not misname the shell (FINDINGS C2)');
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );

  const state = pm.getState(cfg.applicationId, cfg.id);
  assert.equal(state.status, 'failed');
  assert.equal(state.pid, null);
  assert.ok(
    String(state.lastError).includes(missing),
    `lastError should name the directory; got: ${state.lastError}`,
  );
  assert.doesNotMatch(String(state.lastError), /spawn \/bin\/sh ENOENT/);
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), false);
});

test('two concurrent start calls spawn exactly one process, and a later start returns the same pid', { timeout: 30_000 }, async () => {
  const countFile = path.join(DATA_DIR, 'spawn-count.txt');
  const cfg = makeCfg('app_once', 'proc_once', `sh '${COUNTED_SH}'`, { COUNT_FILE: countFile });

  const [first, second] = await withTimeout(
    Promise.all([pm.start(cfg), pm.start(cfg)]),
    20_000,
    'concurrent start() calls never settled',
  );

  // The second call sees `starting` before the first has awaited anything, so it is a pure no-op.
  assert.equal(second.status, 'starting');
  assert.equal(second.pid, null);
  assert.equal(first.status, 'running');
  assert.equal(typeof first.pid, 'number');
  seenPgids.add(first.pid);

  const spawns = fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(spawns.length, 1, `expected exactly one spawn, the fixture recorded ${spawns.length}`);

  const again = await withTimeout(pm.start(cfg), 10_000, 'a redundant start() never settled');
  assert.equal(again.pid, first.pid, 'starting an already-running process must not replace it');
  assert.equal(again.status, 'running');
  assert.equal(
    fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length,
    1,
    'a redundant start() spawned a second process',
  );

  await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');
  assert.equal(groupAlive(first.pid), false);
});

test('stop on a process that was never started is a no-op that does not throw', { timeout: 10_000 }, async () => {
  const state = await withTimeout(
    pm.stop('app_never', 'proc_never'),
    5_000,
    'stop() of an unknown process never settled',
  );

  assert.deepEqual(
    { status: state.status, pid: state.pid, exitCode: state.exitCode, restarts: state.restarts },
    { status: 'stopped', pid: null, exitCode: null, restarts: 0 },
  );
  assert.equal(state.lastError, null);
  assert.equal(pm.isActive('app_never', 'proc_never'), false);
});

test('start then stop inside the settle window does not deadlock the per-process lock', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_window', 'proc_window', 'sleep 30');

  const starting = pm.start(cfg);
  // Well inside START_SETTLE_MS: the lock is held by launch() and stop() has to queue behind it.
  const stopping = pm.stop(cfg.applicationId, cfg.id);

  const [started, stopped] = await withTimeout(
    Promise.all([starting, stopping]),
    START_SETTLE_MS + 15_000,
    'start() then stop() inside the settle window deadlocked',
  );

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  assert.notEqual(started.status, 'running', 'a process stopped mid-window must not be promoted');
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), false);

  // The real symptom of the original bug was the lock never being released, so prove the next
  // call on this key still runs.
  const restarted = await withTimeout(pm.start(cfg), 15_000, 'the per-process lock was never released');
  assert.equal(restarted.status, 'running');
  assert.equal(typeof restarted.pid, 'number');
  seenPgids.add(restarted.pid);

  await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');
  assert.equal(groupAlive(restarted.pid), false);
});

test('restart increments restarts, produces a different pid, and leaves the process running', { timeout: 30_000 }, async () => {
  const cfg = makeCfg('app_restart', 'proc_restart', 'sleep 30');

  const first = await withTimeout(pm.start(cfg), 15_000, 'start() never settled');
  assert.equal(first.status, 'running');
  assert.equal(first.restarts, 0);
  seenPgids.add(first.pid);

  const second = await withTimeout(pm.restart(cfg), 25_000, 'restart() never settled');
  seenPgids.add(second.pid);

  assert.equal(second.status, 'running');
  assert.equal(second.restarts, 1);
  assert.notEqual(second.pid, first.pid, 'restart must produce a new process, not reuse the old pid');
  assert.equal(groupAlive(first.pid), false, 'the previous group must be dead before the new one starts');
  assert.equal(groupAlive(second.pid), true, 'restart must leave the process running');
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), true);

  await withTimeout(pm.stop(cfg.applicationId, cfg.id), 20_000, 'stop() never settled');
  assert.equal(groupAlive(second.pid), false);
});

test('stop acknowledges an already-crashed process while preserving exitCode and lastError', { timeout: 20_000 }, async () => {
  const cfg = makeCfg('app_ack', 'proc_ack', 'printf "why-it-died\\n" >&2; exit 3');

  const crashed = await withTimeout(pm.start(cfg), 15_000, 'start() never settled');
  assert.equal(crashed.status, 'crashed');
  assert.equal(crashed.exitCode, 3);

  const stopped = await withTimeout(
    pm.stop(cfg.applicationId, cfg.id),
    10_000,
    'stop() of a crashed process never settled',
  );

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.exitCode, 3, 'the exit code must survive the acknowledgement');
  assert.equal(stopped.exitSignal, null);
  assert.equal(stopped.lastError, crashed.lastError, 'why it died must stay on the record');
  assert.match(String(stopped.lastError), /why-it-died/);
  assert.equal(pm.isActive(cfg.applicationId, cfg.id), false);
});

test('stdout reaches the log store, including a split line and a final line with no newline', { timeout: 20_000 }, async () => {
  const cfg = makeCfg('app_logs', 'proc_logs', `sh '${LOGGING_SH}'`);

  await withTimeout(pm.start(cfg), 15_000, 'start() never settled');

  await waitUntil(
    () => stdoutMessages(cfg.applicationId, cfg.id).includes('tail-no-newline'),
    10_000,
    'the final line without a trailing newline never reached the log store',
  );

  const messages = stdoutMessages(cfg.applicationId, cfg.id);
  assert.deepEqual(messages, ['first-line', 'split-part', 'tail-no-newline']);

  const entries = logStore
    .read({ applicationId: cfg.applicationId, processIds: [cfg.id], limit: 1_000 })
    .entries;
  const seqs = entries.map((entry) => entry.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'log entries must be ascending by seq');
  assert.equal(entries.every((entry) => entry.processId === cfg.id), true);
});

// The data directory belongs to this run alone; leaving it behind accumulates one
// directory per run in the system temp folder.
after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
