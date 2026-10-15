/**
 * ports.js — correlation, caching and the safety rules around terminating a process.
 *
 * The correlation tiers are exercised against fabricated snapshots rather than a live machine.
 * That is deliberate: the ranking is the part that is easy to get subtly wrong, and against real
 * processes most of these cases (a listener reparented to init, two configured processes sharing a
 * repository, a pid the OS names but will not describe) are impractical to arrange on demand.
 *
 * The live-OS behaviours — that a real scan finds a real listener, and that terminate() refuses to
 * touch a protected pid — are covered separately below with actual processes, because a fabricated
 * snapshot could not catch a parser regression.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js reads the environment at import time, so the data dir is redirected before the first
// project module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;

const ports = await import(new URL('../ports.js', import.meta.url).href);
const platform = await import(new URL('../platform/index.js', import.meta.url).href);

const IS_WIN = process.platform === 'win32';

/** A managed process as service.js hands it to the correlator. */
const managed = (over = {}) => ({
  applicationId: 'app_1',
  applicationName: 'Acme Platform',
  processId: 'proc_1',
  processName: 'frontend',
  pid: 100,
  repositoryPath: path.join(os.tmpdir(), 'repo-a'),
  ...over,
});

/** One listener row as the platform layer produces it. */
const listener = (over = {}) => ({
  port: 5173,
  protocol: 'tcp',
  address: '127.0.0.1',
  family: 'ipv4',
  pid: 100,
  source: 'lsof',
  name: 'node',
  ...over,
});

const proc = (over = {}) => ({
  pid: 100,
  ppid: 1,
  pgid: 100,
  startedAt: 'Sat Sep 12 10:00:00 2026',
  commandLine: 'node server.js',
  executablePath: '/usr/bin/node',
  name: 'node',
  workingDirectory: null,
  ...over,
});

const snapshot = (listeners, processes) => ({
  listeners,
  processes: new Map(processes.map((p) => [p.pid, p])),
});

const ownerOf = (listeners, processes, managedList) =>
  ports.correlate(snapshot(listeners, processes), managedList)[0].owner;

describe('correlation tiers', () => {
  test('tier 1: the listener pid IS a managed pid — the common case, because sh -c execs in place', () => {
    const owner = ownerOf([listener({ pid: 100 })], [proc({ pid: 100 })], [managed({ pid: 100 })]);
    assert.equal(owner.kind, 'managed');
    assert.equal(owner.confidence, 'exact');
    assert.equal(owner.processName, 'frontend');
  });

  test('tier 2: the listener is a grandchild, matched by process group', () => {
    // The manager holds pid 100; the thing actually holding the port is 250, in the same group.
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 100, ppid: 180 })],
      [managed({ pid: 100 })]
    );
    assert.equal(owner.kind, 'managed');
    assert.equal(owner.confidence, 'exact');
  });

  test('tier 2 survives the listener being reparented to init, where ancestry is already broken', () => {
    // ppid 1 means the parent chain is gone entirely. pgid is inherited across fork and outlives it,
    // which is exactly why the group is ranked above ancestry.
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 100, ppid: 1 })],
      [managed({ pid: 100 })]
    );
    assert.equal(owner.confidence, 'exact');
  });

  test('tier 3: ancestry, when the group does not match', () => {
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 180 }), proc({ pid: 180, pgid: 999, ppid: 100 })],
      [managed({ pid: 100 })]
    );
    assert.equal(owner.kind, 'managed');
    assert.equal(owner.confidence, 'high');
  });

  test('a cyclic parent chain terminates instead of hanging', () => {
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 260 }), proc({ pid: 260, pgid: 999, ppid: 250 })],
      [managed({ pid: 100 })]
    );
    assert.equal(owner.kind, 'unmanaged');
  });

  test('tier 4: working directory inside the repository, reported as a weaker match', () => {
    const repo = path.join(os.tmpdir(), 'repo-a');
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 1, workingDirectory: path.join(repo, 'src') })],
      [managed({ pid: 100, repositoryPath: repo })]
    );
    assert.equal(owner.kind, 'managed');
    assert.equal(owner.confidence, 'medium');
  });

  test('a sibling directory with the same prefix is NOT inside the repository', () => {
    const repo = path.join(os.tmpdir(), 'repo-a');
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 1, workingDirectory: `${repo}-evil` })],
      [managed({ pid: 100, repositoryPath: repo })]
    );
    assert.equal(owner.kind, 'unmanaged');
  });

  test('tier 5: the repository path appears in the command line', () => {
    const repo = path.join(os.tmpdir(), 'repo-a');
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 1, commandLine: `node ${repo}/server.js` })],
      [managed({ pid: 100, repositoryPath: repo })]
    );
    assert.equal(owner.confidence, 'low');
  });

  test('a matching process NAME alone is never a match — there are dozens of node processes', () => {
    const owner = ownerOf(
      [listener({ pid: 250, name: 'node' })],
      [proc({ pid: 250, pgid: 999, ppid: 1, name: 'node', commandLine: 'node unrelated.js' })],
      [managed({ pid: 100, processName: 'node' })]
    );
    assert.equal(owner.kind, 'unmanaged');
  });

  test('two processes matching equally well is ambiguous, and claims neither', () => {
    const repo = path.join(os.tmpdir(), 'repo-a');
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 999, ppid: 1, workingDirectory: repo })],
      [
        managed({ pid: 100, processId: 'proc_1', processName: 'frontend', repositoryPath: repo }),
        managed({ pid: 101, processId: 'proc_2', processName: 'worker', repositoryPath: repo }),
      ]
    );
    assert.equal(owner.kind, 'ambiguous');
    assert.equal(owner.applicationId, null, 'must not pick a winner');
    assert.equal(owner.candidates.length, 2);
  });

  test('a stronger tier wins outright over a weaker one, rather than being combined', () => {
    const repo = path.join(os.tmpdir(), 'repo-a');
    // Group says proc_1; working directory says proc_2. First match wins, and it is the group.
    const owner = ownerOf(
      [listener({ pid: 250 })],
      [proc({ pid: 250, pgid: 100, ppid: 1, workingDirectory: repo })],
      [
        managed({ pid: 100, processId: 'proc_1', processName: 'frontend', repositoryPath: '/elsewhere' }),
        managed({ pid: 101, processId: 'proc_2', processName: 'worker', repositoryPath: repo }),
      ]
    );
    assert.equal(owner.processId, 'proc_1');
    assert.equal(owner.confidence, 'exact');
  });

  test('a socket whose owner the OS would not name is unknown, not unmanaged', () => {
    const owner = ownerOf([listener({ pid: null })], [], [managed()]);
    assert.equal(owner.kind, 'unknown');
    assert.equal(owner.reason, 'owner-not-visible');
  });

  test('no managed processes at all still produces a usable row', () => {
    const owner = ownerOf([listener({ pid: 250 })], [proc({ pid: 250 })], []);
    assert.equal(owner.kind, 'unmanaged');
    assert.equal(owner.confidence, null);
  });
});

describe('listener merging', () => {
  test('one logical listener on two address families collapses to a single row keeping both', () => {
    const rows = ports.correlate(
      snapshot(
        [
          listener({ pid: 100, address: '127.0.0.1', family: 'ipv4' }),
          listener({ pid: 100, address: '::1', family: 'ipv6' }),
        ],
        [proc({ pid: 100 })]
      ),
      []
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].addresses, ['127.0.0.1', '::1']);
  });

  test('the same socket seen by both sources is one row, and lsof supplies the untruncated name', () => {
    const rows = ports.correlate(
      snapshot(
        [
          listener({ pid: 100, source: 'netstat', name: 'com.docker.backe' }),
          listener({ pid: 100, source: 'lsof', name: 'com.docker.backend' }),
        ],
        [proc({ pid: 100, name: null })]
      ),
      []
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].processName, 'com.docker.backend');
  });

  test('two different processes on the same port stay two rows', () => {
    const rows = ports.correlate(
      snapshot([listener({ pid: 100 }), listener({ pid: 200 })], [proc({ pid: 100 }), proc({ pid: 200 })]),
      []
    );
    assert.equal(rows.length, 2);
  });

  test('exposure is derived from the addresses, not guessed', () => {
    const [local] = ports.correlate(snapshot([listener({ address: '127.0.0.1' })], [proc()]), []);
    assert.equal(local.exposed, false);
    const [wildcard] = ports.correlate(snapshot([listener({ address: '0.0.0.0' })], [proc()]), []);
    assert.equal(wildcard.exposed, true);
    const [v6any] = ports.correlate(snapshot([listener({ address: '::' })], [proc()]), []);
    assert.equal(v6any.exposed, true);
    const [lan] = ports.correlate(snapshot([listener({ address: '192.168.1.9' })], [proc()]), []);
    assert.equal(lan.exposed, true);
  });

  test('unreadable fields stay null rather than becoming an empty string', () => {
    const [row] = ports.correlate(
      snapshot([listener({ pid: 100 })], [proc({ pid: 100, commandLine: null, executablePath: null, workingDirectory: null })]),
      []
    );
    assert.equal(row.commandLine, null);
    assert.equal(row.executablePath, null);
    assert.equal(row.workingDirectory, null);
  });
});

describe('links', () => {
  // frontend (pid 100, :5173) calls api (pid 200, :3001); redis-server (pid 300, :6379) is not managed.
  const frontend = managed({ processId: 'proc_fe', processName: 'frontend', pid: 100 });
  const api = managed({ processId: 'proc_api', processName: 'api', pid: 200 });
  const processes = [proc({ pid: 100 }), proc({ pid: 200, pgid: 200 }), proc({ pid: 300, pgid: 300, name: 'redis-server' })];
  const listeners = [
    listener({ pid: 100, port: 5173 }),
    listener({ pid: 200, port: 3001, address: '0.0.0.0' }),
    listener({ pid: 300, port: 6379, name: 'redis-server' }),
  ];
  const connection = (pid, localPort, remotePort, over = {}) => ({
    pid,
    localAddress: '127.0.0.1',
    localPort,
    remoteAddress: '127.0.0.1',
    remotePort,
    ...over,
  });
  const linksOf = (connections, managedList = [frontend, api], extra = {}) => {
    const snap = { ...snapshot(listeners, processes), connections, ...extra };
    return ports.correlateLinks(snap, managedList, ports.correlate(snap, managedList));
  };

  test('a connection seen from both ends is one link, from the caller to the listener', () => {
    const found = linksOf([connection(100, 51000, 3001), connection(200, 3001, 51000)]);
    assert.equal(found.length, 1);
    assert.equal(found[0].processId, 'proc_fe');
    assert.equal(found[0].port, 3001);
    assert.equal(found[0].target.kind, 'managed');
    assert.equal(found[0].target.processId, 'proc_api');
  });

  test('a listener Paddock does not run is a link to an unmanaged target, named by the OS', () => {
    const [found] = linksOf([connection(200, 52000, 6379)]);
    assert.equal(found.processId, 'proc_api');
    assert.deepEqual(
      { kind: found.target.kind, name: found.target.name, processId: found.target.processId },
      { kind: 'unmanaged', name: 'redis-server', processId: null }
    );
  });

  test('a caller is matched by its process group, like a listener', () => {
    const snapProcesses = [...processes, proc({ pid: 250, pgid: 200, ppid: 1 })];
    const snap = { ...snapshot(listeners, snapProcesses), connections: [connection(250, 52000, 6379)] };
    const found = ports.correlateLinks(snap, [frontend, api], ports.correlate(snap, [frontend, api]));
    assert.equal(found[0]?.processId, 'proc_api');
  });

  test('a caller that is not a managed process by a strong tier draws no link', () => {
    assert.deepEqual(linksOf([connection(300, 53000, 3001)]), []);
  });

  test('many sockets from one caller to one port are one link', () => {
    const found = linksOf([connection(200, 52000, 6379), connection(200, 52001, 6379), connection(200, 52002, 6379)]);
    assert.equal(found.length, 1);
  });

  test('a connection to another machine is not a link, even on a port something here listens on', () => {
    assert.deepEqual(linksOf([connection(100, 51000, 3001, { remoteAddress: '10.0.0.8' })]), []);
  });

  test("the machine's own LAN address counts as local", () => {
    const found = linksOf(
      [connection(100, 51000, 3001, { remoteAddress: '192.168.1.9' })],
      [frontend, api],
      { localAddresses: new Set(['192.168.1.9']) }
    );
    assert.equal(found.length, 1);
  });

  test('a v4-mapped address reaches a dual-stack listener', () => {
    const found = linksOf([connection(100, 51000, 3001, { remoteAddress: '::ffff:127.0.0.1' })]);
    assert.equal(found.length, 1);
  });

  test('a process connecting to its own second port is not a link', () => {
    const snapListeners = [...listeners, listener({ pid: 200, port: 9090 })];
    const snap = { ...snapshot(snapListeners, processes), connections: [connection(200, 54000, 9090)] };
    assert.deepEqual(ports.correlateLinks(snap, [frontend, api], ports.correlate(snap, [frontend, api])), []);
  });
});

describe('termination safety', () => {
  test('refuses pid 1, pid 0, negatives and non-integers without signalling anything', async () => {
    for (const pid of [1, 0, -1, -5, 1.5, NaN, null, undefined]) {
      const result = await ports.terminate(pid, null);
      assert.equal(result.stopped, false, `pid ${pid} must not be stopped`);
      assert.equal(result.reason, 'protected', `pid ${pid} must be refused as protected`);
    }
  });

  test('refuses the manager\'s own process and its parent', async () => {
    assert.equal((await ports.terminate(process.pid, null)).reason, 'protected');
    if (process.ppid > 1) {
      assert.equal((await ports.terminate(process.ppid, null)).reason, 'protected');
    }
  });

  test('a pid that no longer exists reports not-found rather than throwing', async () => {
    // 999_999 is above PID_MAX on macOS and vanishingly unlikely elsewhere.
    const result = await ports.terminate(999_999, null);
    assert.equal(result.stopped, false);
    assert.equal(result.reason, 'not-found');
  });

  test('a fingerprint that no longer matches aborts instead of signalling a recycled pid', async (t) => {
    if (IS_WIN) return t.skip('POSIX fixture');
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    try {
      await delay(300);
      // The identity we "resolved" belongs to something else entirely.
      const result = await ports.terminate(child.pid, 'Sat Sep 12 00:00:00 2026\u0000totally other command');
      assert.equal(result.stopped, false);
      assert.equal(result.reason, 'identity-changed');
      assert.equal(platform.processExists(child.pid), true, 'the process must be untouched');
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  test('terminates a real process and confirms it is gone', async (t) => {
    if (IS_WIN) return t.skip('POSIX fixture');
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    await delay(300);
    const result = await ports.terminate(child.pid, null);
    assert.equal(result.stopped, true);
    assert.equal(result.forced, false, 'a compliant process should not need SIGKILL');
    assert.equal(platform.processExists(child.pid), false);
  });

  test('escalates to a forced kill for a process that ignores the polite signal', async (t) => {
    if (IS_WIN) return t.skip('POSIX fixture');
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      await delay(400);
      const result = await ports.terminate(child.pid, null);
      assert.equal(result.stopped, true);
      assert.equal(result.forced, true, 'a TERM-ignoring process must be escalated to');
      assert.equal(platform.processExists(child.pid), false);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('scan cache', () => {
  test('a real scan finds a real listener, with its pid and address', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      ports.invalidate();
      const snap = await ports.scan({ force: true });
      const rows = ports.correlate(snap, []);
      const row = rows.find((r) => r.port === port);
      assert.ok(row, `port ${port} should appear in the scan`);
      assert.equal(row.pid, process.pid, 'the listening pid is this test process');
      assert.equal(row.exposed, false, 'bound to 127.0.0.1');
    } finally {
      server.close();
    }
  });

  test('a second scan inside the TTL is served from cache, and invalidate() drops it', async () => {
    const first = await ports.scan({ force: true });
    const second = await ports.scan();
    assert.equal(second.scannedAt, first.scannedAt, 'should not have rescanned');
    assert.equal(ports.peek().scannedAt, first.scannedAt);
    ports.invalidate();
    assert.equal(ports.peek(), null);
  });

  test('force rescans rather than returning the cached snapshot', async () => {
    const first = await ports.scan({ force: true });
    await delay(5);
    const second = await ports.scan({ force: true });
    assert.notEqual(second.scannedAt, first.scannedAt);
  });

  test('concurrent scans share one in-flight OS call', async () => {
    ports.invalidate();
    const [a, b, c] = await Promise.all([ports.scan(), ports.scan(), ports.scan()]);
    assert.equal(a.scannedAt, b.scannedAt);
    assert.equal(b.scannedAt, c.scannedAt);
  });

  test('peek never triggers a scan', () => {
    ports.invalidate();
    assert.equal(ports.peek(), null);
  });
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
