/**
 * Regression suite for PostgreSQL applications: postgres/ and the service paths that route to it.
 *
 * What a data directory says about its server, and following a log file, are file-level and run
 * everywhere. Everything else runs real clusters, because the claims are about real servers: that the
 * server pg_ctl starts survives the Paddock that started it, that one started from a terminal reads
 * as running, that a stop with pooled connections open is fast. Those need initdb and pg_ctl on the
 * PATH, and are skipped without them.
 *
 * The data directory is a fresh temp dir chosen before the first import, because config.js reads the
 * environment at module load. Every cluster this file creates is stopped in `after`, whatever state a
 * failing test left it in — nothing else would, since that is the whole point of running them detached.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-test-')));

process.env.PADDOCK_DATA_DIR = path.join(TMP, 'paddock');
// A .env beside the project root would otherwise leak the developer's settings into the run.
process.env.PADDOCK_ENV_FILE = path.join(TMP, 'absent.env');
process.env.PADDOCK_LOG_PERSIST = 'false';
process.env.PADDOCK_REAP_ORPHANS = 'false';

const service = await import('../service.js');
const dataDirectory = await import('../postgres/data-directory.js');
const follower = await import('../postgres/log-follower.js');
const lifecycle = await import('../postgres/lifecycle.js');

const binariesPresent = ['initdb', 'pg_ctl'].every((bin) => spawnSync(bin, ['--version']).status === 0);
const clusterSkip = process.platform === 'win32'
  ? 'real clusters are exercised on POSIX only'
  : !binariesPresent && 'initdb and pg_ctl are not on PATH — install PostgreSQL to run these';

// --- helpers ---------------------------------------------------------------------------------

let counter = 0;
const unique = (prefix) => `${prefix}-${++counter}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await delay(50);
  }
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Every cluster made here, so `after` can stop what a failing test left running. */
const clusters = [];

function initCluster(parent = TMP) {
  const dir = path.join(parent, unique('pgdata'));
  execFileSync('initdb', ['-D', dir, '-U', 'paddock', '--auth=trust', '--no-sync'], { stdio: 'ignore' });
  clusters.push(dir);
  return dir;
}

const pgCtl = (args) => execFileSync('pg_ctl', args, { stdio: 'ignore' });

const createPostgres = async (dir, port, extra = {}) => service.createApplication({
  name: unique('pg'),
  kind: 'postgres',
  postgres: { dataDirectory: dir, port, user: 'paddock', ...extra },
});

const serverOf = async (applicationId) => (await service.getApplication(applicationId)).processes[0];

after(async () => {
  for (const dir of clusters) {
    try {
      pgCtl(['stop', '-D', dir, '-m', 'immediate', '-w']);
    } catch {
      // Not running — the usual case for a test that cleaned up after itself.
    }
  }
  await service.shutdown();
  await fs.rm(TMP, { recursive: true, force: true });
});

// --- pg_ctl environment ----------------------------------------------------------------------

describe('the environment pg_ctl inherits', () => {
  test('a process with no locale — launchd at login — gets LC_ALL=C, so macOS will not thread the postmaster', () => {
    assert.deepEqual(lifecycle.pgCtlEnv({ PATH: '/usr/bin' }), { PATH: '/usr/bin', LC_ALL: 'C' });
    assert.equal(lifecycle.pgCtlEnv({ LANG: '' }).LC_ALL, 'C');
  });

  test('a locale already set is left alone', () => {
    const env = { LANG: 'he_IL.UTF-8' };
    assert.equal(lifecycle.pgCtlEnv(env), env);
    assert.equal(lifecycle.pgCtlEnv({ LC_ALL: 'en_US.UTF-8' }).LC_ALL, 'en_US.UTF-8');
  });
});

// --- data directory --------------------------------------------------------------------------

describe('what a data directory says about its server', () => {
  test('no postmaster.pid is a stopped server, and not a crashed one', async () => {
    const dir = path.join(TMP, unique('empty'));
    await fs.mkdir(dir);
    assert.deepEqual(await dataDirectory.inspect(dir), { running: false, stale: false });
  });

  test('a postmaster.pid whose process is gone is stale — the server did not shut down cleanly', async () => {
    const dir = path.join(TMP, unique('stale'));
    await fs.mkdir(dir);
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => gone.on('exit', resolve));
    await fs.writeFile(path.join(dir, 'postmaster.pid'), `${gone.pid}\n${dir}\n1700000000\n5432\n`);
    assert.deepEqual(await dataDirectory.inspect(dir), { running: false, stale: true });
  });

  test('a postmaster.pid of a live process is a running server, with its port, start time and phase', async () => {
    const dir = path.join(TMP, unique('live'));
    await fs.mkdir(dir);
    const lines = [process.pid, dir, 1_700_000_000, 6123, '/tmp', 'localhost', '1234 5', 'stopping'];
    await fs.writeFile(path.join(dir, 'postmaster.pid'), `${lines.join('\n')}\n`);
    assert.deepEqual(await dataDirectory.inspect(dir), {
      running: true,
      pid: process.pid,
      port: 6123,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      phase: 'stopping',
    });
  });

  test('the configured port: postgresql.auto.conf over postgresql.conf, the last line in a file, 5432 without either', async () => {
    const dir = path.join(TMP, unique('conf'));
    await fs.mkdir(dir);
    assert.equal(await dataDirectory.configuredPort(dir), 5432);
    await fs.writeFile(path.join(dir, 'postgresql.conf'), '#port = 1111\nport = 2222\nport = 3333 # later wins\n');
    assert.equal(await dataDirectory.configuredPort(dir), 3333);
    await fs.writeFile(path.join(dir, 'postgresql.auto.conf'), "port = '4444'\n");
    assert.equal(await dataDirectory.configuredPort(dir), 4444);
  });
});

// --- log follower ----------------------------------------------------------------------------

describe('following a log file', () => {
  const collect = (key, file) => {
    const lines = [];
    const started = follower.follow(key, file, (line) => lines.push(line));
    return { lines, started };
  };

  test('starts at the end of an existing file, then delivers appended lines — one split across writes whole', async (t) => {
    const file = path.join(TMP, unique('follow.log'));
    await fs.writeFile(file, 'history before following\n');
    const key = unique('follower');
    t.after(() => follower.unfollow(key));

    const { lines, started } = collect(key, file);
    await started;
    await fs.appendFile(file, 'first\nsec');
    await fs.appendFile(file, 'ond\n');
    await waitFor(() => lines.length === 2, 'both appended lines');
    assert.deepEqual(lines, ['first', 'second']);
  });

  test('a file that does not exist yet is read from its first byte once it appears', async (t) => {
    const file = path.join(TMP, unique('later.log'));
    const key = unique('follower');
    t.after(() => follower.unfollow(key));

    const { lines, started } = collect(key, file);
    await started;
    await fs.writeFile(file, 'created after following began\n');
    await waitFor(() => lines.length === 1, 'the first line of the new file');
    assert.deepEqual(lines, ['created after following began']);
  });

  test('a truncated file is read again from its start', async (t) => {
    const file = path.join(TMP, unique('truncated.log'));
    await fs.writeFile(file, '');
    const key = unique('follower');
    t.after(() => follower.unfollow(key));

    const { lines, started } = collect(key, file);
    await started;
    await fs.appendFile(file, 'a fairly long line before the rotation\n');
    await waitFor(() => lines.length === 1, 'the line before truncation');
    await fs.writeFile(file, 'short\n');
    await waitFor(() => lines.length === 2, 'the line after truncation');
    assert.equal(lines[1], 'short');
  });
});

// --- real clusters ---------------------------------------------------------------------------

describe('a real cluster', { skip: clusterSkip, timeout: 120_000 }, () => {
  test('starts, logs into the viewer, answers SQL, and stops fast with pooled connections open', async (t) => {
    const app = await createPostgres(initCluster(), await freePort());
    t.after(() => service.stopApplication(app.id).then(() => service.deleteApplication(app.id)));

    const { results } = await service.startApplication(app.id);
    assert.deepEqual(results.map((r) => [r.processId, r.ok, r.status]), [['postgres', true, 'running']]);

    await waitFor(async () => {
      const { entries } = await service.readLogs({ applicationId: app.id, processId: 'postgres' });
      return entries.some((entry) => /ready to accept connections/.test(entry.message));
    }, 'the server log to reach the log store');

    await service.runSql({ applicationId: app.id, database: 'postgres', sql: 'CREATE TABLE notes (body text)' });
    await service.runSql({
      applicationId: app.id,
      database: 'postgres',
      sql: 'INSERT INTO notes VALUES ($1)',
      params: ['hello'],
    });
    const read = await service.runReadOnlySql({ applicationId: app.id, database: 'postgres', sql: 'SELECT body FROM notes' });
    assert.deepEqual(read.rows, [{ body: 'hello' }]);

    // The pool still holds its connections. A smart shutdown would wait on them until pg_ctl gave up
    // a minute later; a fast one is done in a fraction of a second.
    const startedAt = Date.now();
    const stopped = await service.stopApplication(app.id);
    assert.equal(stopped.results[0].status, 'stopped');
    assert.ok(Date.now() - startedAt < 5_000, `stop took ${Date.now() - startedAt}ms`);
  });

  test('the SQL console reads by default, one statement that cannot escape its read-only transaction', async (t) => {
    const app = await createPostgres(initCluster(), await freePort());
    t.after(() => service.stopApplication(app.id).then(() => service.deleteApplication(app.id)));
    const statement = (sql, extra = {}) => service.runStatement(app.id, { database: 'postgres', sql, ...extra });

    await assert.rejects(statement('SELECT 1'), /is stopped — start it first/);
    await service.startApplication(app.id);

    const created = await statement('CREATE TABLE notes (id int); INSERT INTO notes VALUES (1), (2)', { readOnly: false });
    assert.deepEqual([created.command, created.rowCount, created.readOnly], ['CREATE, INSERT', 2, false]);

    // Two columns with one name stay two columns.
    const joined = await statement('SELECT 1 AS id, 2 AS id');
    assert.deepEqual([joined.columns, joined.rows, joined.readOnly], [['id', 'id'], [[1, 2]], true]);

    // Over the simple protocol this commits the read-only transaction and then deletes, committed.
    await assert.rejects(statement('COMMIT; DELETE FROM notes'), /multiple commands/);
    await assert.rejects(statement('DELETE FROM notes'), /read-only transaction/);
    assert.deepEqual((await statement('SELECT count(*) FROM notes')).rows, [[2]]);

    await assert.rejects(statement('SELECT nope FROM notes'), (err) => {
      assert.equal(err.constructor.name, 'DatabaseError');
      assert.deepEqual([err.code, err.position], ['42703', '8']);
      return true;
    });
  });

  test('a start that fails says why, in the server\'s own words, and Stop clears it', async (t) => {
    // Port 1 is privileged: the server cannot bind it, and says so with a FATAL line.
    const app = await createPostgres(initCluster(), 1);
    t.after(() => service.deleteApplication(app.id));

    const { results } = await service.startApplication(app.id);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /^pg_ctl: could not start server — .*FATAL:/);
    assert.equal((await service.getApplication(app.id)).status, 'failed');

    const cleared = await service.stopApplication(app.id);
    assert.equal(cleared.results[0].status, 'stopped');
    assert.match((await serverOf(app.id)).lastError, /FATAL:/, 'the reason stays on the record');
  });

  test('a server started and stopped from a terminal is seen without Paddock doing either', async (t) => {
    const dir = initCluster();
    const port = await freePort();
    const app = await createPostgres(dir, port);
    t.after(() => service.deleteApplication(app.id));

    pgCtl(['start', '-D', dir, '-l', path.join(TMP, unique('terminal.log')), '-o', `-p ${port}`, '-w']);
    const running = await serverOf(app.id);
    assert.equal(running.status, 'running');
    assert.ok(alive(running.pid));
    assert.equal((await service.clusterInfo(app.id)).port, port, 'the tools connect to it as it is');

    pgCtl(['stop', '-D', dir, '-m', 'fast', '-w']);
    assert.equal((await serverOf(app.id)).status, 'stopped');
  });

  test('deleting the application leaves its server running', async () => {
    const dir = initCluster();
    const app = await createPostgres(dir, await freePort());
    const { application } = await service.startApplication(app.id);
    const { pid } = application.processes[0];

    await service.deleteApplication(app.id);
    assert.equal(alive(pid), true, 'the server went down with its application');
    pgCtl(['stop', '-D', dir, '-m', 'fast', '-w']);
  });

  test('the server outlives the Paddock that started it, and the next Paddock picks it up as running', async () => {
    const dir = initCluster();
    const env = {
      ...process.env,
      PADDOCK_DATA_DIR: path.join(TMP, unique('spawned')),
      PADDOCK_PORT: '0',
      PADDOCK_ENV_FILE: path.join(TMP, 'absent.env'),
      PADDOCK_REAP_ORPHANS: 'false',
    };
    const boot = async () => {
      const child = spawn(process.execPath, ['server.js'], { cwd: ROOT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.resume();
      const match = await waitFor(() => /UI\s+http:\/\/[^:]+:(\d+)/.exec(output), 'Paddock to listen');
      return { child, base: `http://127.0.0.1:${match[1]}` };
    };
    const call = async (base, method, route, body) => {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.status === 204 ? null : res.json();
    };
    const exit = (child) => new Promise((resolve) => {
      child.on('exit', resolve);
      child.kill('SIGTERM');
    });

    const first = await boot();
    const app = await call(first.base, 'POST', '/api/applications', {
      name: 'pg-outlives',
      kind: 'postgres',
      postgres: { dataDirectory: dir, port: await freePort(), user: 'paddock' },
    });
    const started = await call(first.base, 'POST', `/api/applications/${app.id}/start`);
    const { pid } = started.application.processes[0];
    assert.equal(started.results[0].status, 'running');

    await exit(first.child);
    assert.equal(alive(pid), true, 'the server went down with Paddock');

    const second = await boot();
    try {
      const seen = (await call(second.base, 'GET', `/api/applications/${app.id}`)).processes[0];
      assert.deepEqual([seen.status, seen.pid], ['running', pid]);

      // The console over REST, against the server the first Paddock started.
      const databases = await call(second.base, 'GET', `/api/applications/${app.id}/databases`);
      assert.ok(databases.some((row) => row.name === 'postgres'));
      const rows = await call(second.base, 'POST', `/api/applications/${app.id}/sql`, { database: 'postgres', sql: 'SELECT 42 AS answer' });
      assert.deepEqual([rows.columns, rows.rows], [['answer'], [[42]]]);
      const bad = await fetch(`${second.base}/api/applications/${app.id}/sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: 'postgres', sql: 'SELEC 1' }),
      });
      assert.equal(bad.status, 400, 'a mistake in the SQL is the caller\'s, not a server error');
      assert.equal((await bad.json()).error.database.code, '42601');

      const stopped = await call(second.base, 'POST', `/api/applications/${app.id}/stop`);
      assert.equal(stopped.results[0].status, 'stopped');
      assert.equal(alive(pid), false);
    } finally {
      await exit(second.child);
    }
  });

  test('discovery finds a running cluster with its port and log, and a stopped one in the home directory', async (t) => {
    const home = path.join(TMP, unique('home'));
    await fs.mkdir(home);
    const stoppedDir = initCluster(home);
    const runningDir = initCluster();
    const port = await freePort();
    const logFile = path.join(TMP, unique('discovered.log'));
    pgCtl(['start', '-D', runningDir, '-l', logFile, '-o', `-p ${port}`, '-w']);
    t.after(() => pgCtl(['stop', '-D', runningDir, '-m', 'fast', '-w']));
    const app = await createPostgres(runningDir, port);
    t.after(() => service.deleteApplication(app.id));

    const realHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      process.env.HOME = realHome;
    });
    const { clusters: found } = await service.discoverClusters();

    const running = found.find((cluster) => cluster.dataDirectory === runningDir);
    assert.ok(running, 'the running cluster was not found');
    assert.deepEqual(
      [running.running, running.port, running.logFile, running.claimedBy?.id],
      [true, port, logFile, app.id]
    );
    const stopped = found.find((cluster) => cluster.dataDirectory === stoppedDir);
    assert.ok(stopped, 'the stopped cluster in the home directory was not found');
    assert.deepEqual([stopped.running, stopped.pid, stopped.claimedBy], [false, null, null]);
    assert.match(stopped.version, /^\d+$/);
  });
});
