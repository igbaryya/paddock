/**
 * platform/ — the OS seam.
 *
 * These tests pin the measured invariants the whole kill path stands on: a spawned child leads its
 * OWN process group (so `kill(-pid)` reaches the tree and not the manager), EPERM means alive,
 * a small pid is never turned into a group probe, and `describeLeader` returns a fingerprint that
 * is not truncated by the terminal width.
 *
 * The suite is POSIX-only and skips wholesale on win32: every assertion below is about process
 * groups and signals, which Windows does not have. The win32 implementation (taskkill/tasklist)
 * needs its own suite run on Windows; there is no meaningful cross-platform assertion to share.
 */
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// config.js reads the environment at import time. platform/ does not import it today, but the data
// dir is redirected before any project module is loaded so that stays true by construction.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;

const platform = await import(new URL('../platform/index.js', import.meta.url).href);

/** Live process groups this file created, group-killed after every test even when one fails. */
const spawnedPgids = new Set();

/**
 * A pipeline, so the tree is the shape a real `npm run dev` takes: /bin/sh stays alive as the group
 * leader with two children under it. A bare `sleep 30` would be exec-optimised by the shell and the
 * "the pid is the group, not the shell" invariant would never be exercised (FINDINGS A2).
 */
const TREE_COMMAND = 'sleep 30 | cat';
const TREE_MEMBERS = 3;

/** Runs the command through the platform's own shell + spawn options — the seam under test. */
function spawnGroup(command) {
  const { file, args } = platform.shellInvocation(command);
  const child = spawn(file, args, {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    ...platform.spawnOptions({ cwd: os.tmpdir(), env: process.env }),
  });
  assert.equal(typeof child.pid, 'number', 'spawn did not produce a pid');
  spawnedPgids.add(child.pid);
  child.stderr.resume();
  // stdout must be consumed or the child blocks; keeping the text lets a test wait on a marker.
  child.stdoutText = '';
  child.stdout.on('data', (chunk) => {
    child.stdoutText += chunk.toString();
  });
  return child;
}

/** Pids currently in a process group; `ps -g` exits non-zero once the group is empty. */
function groupPids(pgid) {
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** pgid as the kernel reports it, so the `child.pid === pgid` claim is checked against ps, not code. */
function pgidOf(pid) {
  const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  assert.match(out, /^\d+$/, `ps reported no pgid for pid ${pid}: ${JSON.stringify(out)}`);
  return Number(out);
}

/** Everything still in a process group, for a timeout message that names the survivor. */
function groupMembers(pgid) {
  try {
    return execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=,command=', '-g', String(pgid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '(no members)';
  }
}

/** Polls a real OS transition to a deadline; a timeout fails with the reason, never silently. */
async function waitFor(predicate, message, timeoutMs = 10_000, pgid) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  const survivors = pgid === undefined ? '' : `\nstill in group ${pgid}:\n${groupMembers(pgid)}`;
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${message}${survivors}`);
}

/**
 * Waits until the whole tree exists before anything signals it. `kill(-pgid)` walks the process
 * table, so a child forked *during* that walk is never signalled and is left orphaned in the group
 * — a real POSIX race, and one a test that signals the instant the shell starts will hit.
 */
async function waitForGroup(pgid, memberCount) {
  await waitFor(
    () => groupPids(pgid).length >= memberCount,
    `group ${pgid} to contain ${memberCount} members`,
    10_000,
    pgid,
  );
}

/** Resolves once the child has written `marker` on stdout, driven by the stream's own events. */
function waitForStdout(child, marker, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!child.stdoutText.includes(marker)) return;
      cleanup();
      resolve();
    };
    const fail = (why) => {
      cleanup();
      reject(new Error(`${why} waiting for ${JSON.stringify(marker)} from pid ${child.pid}; ` +
        `stdout so far: ${JSON.stringify(child.stdoutText)}`));
    };
    const onEnd = () => fail('child stdout ended before');
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.stdout.off('end', onEnd);
    };
    child.stdout.on('data', check);
    child.stdout.on('end', onEnd);
    check();
  });
}

/**
 * A root-owned process group we are not allowed to signal, confirmed by an actual EPERM from a
 * signal-0 probe. Returns null when the host has none (or we are root), so the test skips rather
 * than asserting something the machine cannot demonstrate.
 */
function findUnsignallableGroup() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,user='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, pgid, user] = match;
    // Group leaders only (pid === pgid), and never pid 1 — `kill(-1, …)` is "every process".
    if (pid !== pgid || user !== 'root' || Number(pgid) <= 1) continue;
    try {
      process.kill(-Number(pgid), 0);
    } catch (err) {
      if (err.code === 'EPERM') return Number(pgid);
    }
  }
  return null;
}

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  const pgids = [...spawnedPgids];
  spawnedPgids.clear();
  for (const pgid of pgids) {
    // Re-send rather than fire once: a tree that is still forking can outrun a single group kill,
    // and this file must not leave a stray `sleep` on the developer's machine.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        break; // ESRCH — the group is gone.
      }
      if (!platform.treeAlive(pgid)) break;
      await delay(20);
    }
  }
});

describe('platform (POSIX)', { skip: IS_WIN && 'POSIX-only: Windows has no process groups' }, () => {
  test('platformName is posix', () => {
    assert.equal(platform.platformName, 'posix');
  });

  describe('shellInvocation', () => {
    test('runs the command through /bin/sh -c', () => {
      assert.deepEqual(platform.shellInvocation('echo hi'), {
        file: '/bin/sh',
        args: ['-c', 'echo hi'],
      });
    });

    test('passes a command with &&, a pipe and quotes through byte-for-byte', () => {
      const command = `cd "/tmp/a b" && grep -n 'x || y' f.txt | head -n 2 && echo "done"`;
      const { file, args } = platform.shellInvocation(command);
      assert.equal(file, '/bin/sh');
      assert.equal(args.length, 2);
      assert.equal(args[0], '-c');
      assert.equal(args[1], command);
    });

    test('the command reaches the shell unmodified end to end', async () => {
      // The contract is not just string equality: the argv must actually make sh evaluate the
      // operators rather than treat them as literal text.
      const child = spawnGroup(`echo 'a|b' && printf '%s' "c&&d" | tr 'c' 'C'`);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.equal(out, 'a|b\nC&&d');
    });
  });

  describe('spawnOptions', () => {
    test('sets detached: true and nothing else on POSIX', () => {
      assert.deepEqual(platform.spawnOptions({ cwd: '/tmp', env: {} }), { detached: true });
    });

    test('a child spawned with it leads its own process group (pgid === pid)', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      const pgid = pgidOf(child.pid);
      assert.equal(
        pgid,
        child.pid,
        'child.pid must BE the process group id — every kill in the manager targets -child.pid',
      );
    });

    test("the child's group is not the test runner's own group", async () => {
      const ownPgid = pgidOf(process.pid);
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      assert.notEqual(
        pgidOf(child.pid),
        ownPgid,
        'without detached the child lands in the manager group and kill(-pgid) kills the manager',
      );
    });

    test('the whole tree, not just the direct child, is in the spawned group', async () => {
      // `sleep | cat` keeps /bin/sh alive as the leader with two children under it: exactly the
      // shape a `npm run dev` takes, and the reason a single-pid kill is not enough.
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      const members = groupPids(child.pid).map(Number);
      assert.equal(
        members.includes(child.pid),
        true,
        `the leader ${child.pid} is not in its own group: ${members}`,
      );
      assert.equal(
        members.length,
        3,
        `expected the leader plus two pipeline members in group ${child.pid}, got ${members}`,
      );
    });
  });

  describe('treeAlive', () => {
    test('is true for a live group and false once that group is killed', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);
      const pgid = child.pid;

      assert.equal(platform.treeAlive(pgid), true);

      process.kill(-pgid, 'SIGKILL');
      await waitFor(() => !platform.treeAlive(pgid), `group ${pgid} to disappear after SIGKILL`);
      assert.equal(platform.treeAlive(pgid), false);
    });

    test('is true for a group that exists but cannot be signalled (EPERM means alive)', (t) => {
      if (IS_ROOT) return t.skip('running as root: nothing on this host is unsignallable');
      const pgid = findUnsignallableGroup();
      if (pgid === null) return t.skip('no root-owned process group found on this host');

      // Proven EPERM above. Reading that as "gone" is how a manager reports stopped while a tree
      // is still holding a port.
      assert.throws(() => process.kill(-pgid, 0), { code: 'EPERM' });
      assert.equal(platform.treeAlive(pgid), true);
    });

    test('refuses pid 1 rather than probing every process on the machine', () => {
      // `kill(-1, …)` is not "group 1" — POSIX defines it as every process the caller may signal,
      // so it ALWAYS succeeds and would read as alive for the wrong reason. No group we spawn can
      // ever be 1, so the implementation refuses it outright.
      assert.doesNotThrow(() => process.kill(-1, 0));
      assert.equal(platform.treeAlive(1), false);
    });

    for (const [label, value] of [
      ['zero', 0],
      ['a negative pid', -1],
      ['a large negative pid', -4242],
      ['a non-integer', 1234.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a numeric string', '4242'],
      ['null', null],
      ['undefined', undefined],
    ]) {
      test(`returns false without throwing for ${label}`, () => {
        assert.equal(platform.treeAlive(value), false);
      });
    }

    test('pid 0 is refused instead of reading the caller\'s own group as alive', () => {
      // `kill(0, 0)` addresses the caller's group and silently succeeds, so an unguarded probe
      // would report "alive" for every 0 the manager ever passed in.
      assert.doesNotThrow(() => process.kill(0, 0));
      assert.equal(platform.treeAlive(0), false);
    });
  });

  describe('signalTree', () => {
    test('resolves on an already-dead group (ESRCH is success, not an error)', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);
      const pgid = child.pid;

      process.kill(-pgid, 'SIGKILL');
      await waitFor(() => !platform.treeAlive(pgid), `group ${pgid} to disappear`, 10_000, pgid);

      await assert.doesNotReject(() => platform.signalTree(pgid, { force: false }));
      await assert.doesNotReject(() => platform.signalTree(pgid, { force: true }));
      await assert.doesNotReject(() => platform.signalTree(pgid));
    });

    test('SIGTERM stops a compliant tree', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      await platform.signalTree(child.pid, { force: false });
      await waitFor(
        () => !platform.treeAlive(child.pid),
        `compliant group ${child.pid} to die on SIGTERM`,
      );
    });

    test('force: true kills a tree that ignores SIGTERM', async () => {
      // The shell ignores TERM and re-spawns its sleep, so the group outlives a graceful stop —
      // this is the escalation path STOP_GRACE_MS exists for.
      const child = spawnGroup('trap "" TERM; echo ready; while :; do sleep 1; done');
      await waitForStdout(child, 'ready');
      const pgid = child.pid;

      await platform.signalTree(pgid, { force: false });

      // Sample across a window a compliant tree would have died in many times over (measured:
      // ESRCH at +51ms) and require it alive at every sample.
      for (let i = 0; i < 20; i += 1) {
        await delay(25);
        assert.equal(
          platform.treeAlive(pgid),
          true,
          `TERM-ignoring group ${pgid} died on SIGTERM — the test no longer proves escalation`,
        );
      }

      await platform.signalTree(pgid, { force: true });
      await waitFor(
        () => !platform.treeAlive(pgid),
        `TERM-ignoring group ${pgid} to die on SIGKILL`,
        5_000,
      );
    });

    test('refuses pid 0 instead of signalling the caller\'s own group', async () => {
      // If this guard ever breaks, this test does not fail — the runner is killed.
      await assert.doesNotReject(() => platform.signalTree(0, { force: true }));
      await assert.doesNotReject(() => platform.signalTree(1, { force: true }));
      await assert.doesNotReject(() => platform.signalTree(-1, { force: true }));
      assert.equal(typeof process.pid, 'number');
    });
  });

  describe('killTreeSync', () => {
    test('kills a live group synchronously and is safe to call twice', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);
      const pgid = child.pid;

      platform.killTreeSync(pgid);
      await waitFor(
        () => !platform.treeAlive(pgid),
        `group ${pgid} to die on killTreeSync`,
        10_000,
        pgid,
      );

      assert.doesNotThrow(() => platform.killTreeSync(pgid));
    });

    test('refuses small pids rather than killing the caller\'s own group', () => {
      assert.doesNotThrow(() => platform.killTreeSync(0));
      assert.doesNotThrow(() => platform.killTreeSync(1));
      assert.doesNotThrow(() => platform.killTreeSync(-1));
      assert.doesNotThrow(() => platform.killTreeSync(NaN));
    });
  });

  describe('describeLeader', () => {
    test('returns a start time and command for a live pid', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      const info = await platform.describeLeader(child.pid);
      assert.notEqual(info, null, 'a live pid must be describable');
      // Fixed `ps -o lstart=` format: "Www Mmm dd HH:MM:SS YYYY".
      assert.match(info.startedAt, /^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/);
      assert.ok(
        Number.isFinite(Date.parse(info.startedAt)),
        `startedAt is not a parseable date: ${info.startedAt}`,
      );
      assert.equal(info.command.startsWith('/bin/sh -c '), true, info.command);
      assert.equal(info.command.includes('sleep 30 | cat'), true, info.command);
    });

    test('does not truncate a long command line', async () => {
      // The orphan reaper compares this string verbatim against the recorded one, so any width
      // dependent truncation makes a recorded fingerprint permanently unmatchable.
      const marker = `MARK-${'x'.repeat(400)}-END`;
      const child = spawnGroup(`${TREE_COMMAND} # ${marker}`);
      await waitForGroup(child.pid, TREE_MEMBERS);

      const info = await platform.describeLeader(child.pid);
      assert.notEqual(info, null);
      assert.equal(
        info.command.includes(marker),
        true,
        `command was truncated at ${info.command.length} chars: ${info.command}`,
      );
      assert.equal(info.command.endsWith('-END'), true, info.command);
    });

    test('the fingerprint is stable across calls', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);

      const first = await platform.describeLeader(child.pid);
      const second = await platform.describeLeader(child.pid);
      assert.deepEqual(second, first);
    });

    test('returns null for a dead pid', async () => {
      const child = spawnGroup(TREE_COMMAND);
      await waitForGroup(child.pid, TREE_MEMBERS);
      const pgid = child.pid;

      process.kill(-pgid, 'SIGKILL');
      await once(child, 'exit');
      await waitFor(() => !platform.treeAlive(pgid), `group ${pgid} to disappear`, 10_000, pgid);
      // The leader is reaped by Node on 'exit', but a zombie can linger a beat in ps.
      await waitFor(
        async () => (await platform.describeLeader(pgid)) === null,
        `describeLeader(${pgid}) to report the dead leader as gone`,
      );
    });

    test('returns null for pids it refuses to touch', async () => {
      assert.equal(await platform.describeLeader(0), null);
      assert.equal(await platform.describeLeader(1), null);
      assert.equal(await platform.describeLeader(-1), null);
      assert.equal(await platform.describeLeader(NaN), null);
      assert.equal(await platform.describeLeader('1234'), null);
    });
  });

  describe('loginShellPath', () => {
    test('settles to null rather than hanging when the timeout is too short', async () => {
      const started = Date.now();
      const result = await platform.loginShellPath(1);
      const elapsed = Date.now() - started;

      // Measured cost of a real `-ilc` login shell is ~540ms; 1ms cannot succeed.
      assert.equal(result, null);
      assert.ok(elapsed < 5_000, `a 1ms budget took ${elapsed}ms to settle`);
    });

    test('resolves a string or null, never throws, with a workable timeout', async () => {
      const result = await platform.loginShellPath(15_000);
      if (result === null) return; // No SHELL, or the login shell failed — a documented outcome.

      assert.equal(typeof result, 'string');
      assert.equal(result.includes('/'), true, `not a PATH: ${JSON.stringify(result)}`);
      assert.equal(result.includes('\n'), false, 'rc-file chatter leaked into the PATH');
      assert.equal(result, result.trim(), 'PATH was returned untrimmed');
    });

    test('an unusable timeout does not become "no timeout"', async () => {
      // 0 / NaN fall back to the module's own ceiling instead of disabling the bound; the only
      // observable is that the call still settles.
      const results = await Promise.all([
        platform.loginShellPath(0),
        platform.loginShellPath(NaN),
        platform.loginShellPath(-5),
        platform.loginShellPath(undefined),
      ]);
      for (const result of results) {
        assert.equal(result === null || typeof result === 'string', true);
      }
    });
  });
});
