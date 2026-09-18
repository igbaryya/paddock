/**
 * Regression suite for service.js — the facade the REST layer and the MCP layer both consume.
 *
 * Everything here is driven through real child processes rather than a mocked process-manager, so
 * what is pinned is the behaviour a user actually gets: which statuses a real crash produces, which
 * processes a start skips, whether a delete really kills the group it was holding. The data
 * directory is a fresh temp dir chosen before the first import, because config.js reads the
 * environment at module load.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SETTLE_MS = 600;
const GRACE_MS = 800;
/** Long enough that a fixture outlives the test that started it, short enough to be a poor orphan. */
const LONG = 20;

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-test-'));
const REPO_DIR = path.join(DATA_DIR, 'repo');
const SUB_DIR = path.join(REPO_DIR, 'packages', 'api');
await fs.mkdir(SUB_DIR, { recursive: true });

process.env.PADDOCK_DATA_DIR = DATA_DIR;
// A .env beside the project root would otherwise leak the developer's settings into the run.
process.env.PADDOCK_ENV_FILE = path.join(DATA_DIR, 'absent.env');
process.env.PADDOCK_LOG_PERSIST = 'false';
process.env.PADDOCK_START_SETTLE_MS = String(SETTLE_MS);
process.env.PADDOCK_STOP_GRACE_MS = String(GRACE_MS);
process.env.PADDOCK_REAP_ORPHANS = 'false';

const service = await import('../service.js');
const logStore = await import('../log-store.js');
const { treeAlive } = await import('../platform/index.js');

/** Every fixture command is POSIX shell; the Windows implementation needs its own fixtures. */
const skip = process.platform === 'win32' ? 'fixtures require a POSIX shell' : false;
const suite = (name, fn) => test(name, { skip, timeout: 90_000 }, fn);

// --- fixtures --------------------------------------------------------------------------------

let counter = 0;
const unique = (prefix) => `${prefix}-${++counter}`;

const COMMANDS = {
  /** Survives the settle window and then some — reaches `running`. */
  runner: (name) => `echo ${name}; sleep ${LONG}`,
  /** Exits inside the settle window — reaches `crashed`. */
  crasher: (name) => `echo ${name}; exit 3`,
  /** Ignores SIGTERM (the disposition is inherited by the sleeps), so a stop must escalate. */
  stubborn: () => `trap '' TERM; while true; do sleep 0.2; done`,
  /** Its repository directory is deleted after registration — the spawn fails, reaching `failed`. */
  broken: (name) => `echo ${name}; sleep ${LONG}`,
};

async function createApp(specs) {
  const app = await service.createApplication({ name: unique('app') });
  const processes = [];
  for (const spec of specs) {
    const view = await service.addProcess(app.id, {
      name: spec.name,
      repositoryPath: spec.repositoryPath ?? REPO_DIR,
      command: spec.command,
      enabled: spec.enabled ?? true,
    });
    processes.push(view.processes.find((p) => p.name === spec.name));
  }
  return { id: app.id, name: app.name, processes };
}

/** Deleting through the service is also what kills the fixture's process groups. */
const dispose = async (applicationId) => {
  await service.deleteApplication(applicationId).catch(() => {});
};

const viewOf = (applicationId) => service.getApplication(applicationId);

const processOf = async (applicationId, processId) =>
  (await viewOf(applicationId)).processes.find((p) => p.id === processId);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll rather than sleep: every wait here is on a real OS transition, and a fixed sleep either
 * makes the suite slow or makes it lie.
 */
async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await delay(10);
  }
}

const waitForProcessStatus = (applicationId, processId, status) =>
  waitFor(
    async () => (await processOf(applicationId, processId)).status === status,
    `process ${processId} to report '${status}'`
  );

/**
 * The manager updates its orphan-reaper record without awaiting it, so a write can still land in
 * the data directory just after shutdown resolves and make a single rm race with it.
 */
async function removeDataDir(attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(DATA_DIR, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await delay(50);
    }
  }
}

after(async () => {
  await service.shutdown();
  await removeDataDir();
});

// --- application status precedence -----------------------------------------------------------

/**
 * Each row builds a real application, drives its processes into the named combination of runtime
 * statuses, and asserts the single status the facade rolls them up to.
 *
 * `act` is applied in two phases so overlapping transitions can coexist: everything that settles is
 * started and awaited first, then the in-flight `starting` and `stopping` windows are opened.
 */
const PRECEDENCE_ROWS = [
  {
    name: 'an application with no processes is stopped',
    specs: [],
    expect: 'stopped',
  },
  {
    name: 'an application whose processes were never started is stopped',
    specs: [{ kind: 'runner' }, { kind: 'runner' }],
    expect: 'stopped',
  },
  {
    name: 'an application whose only process is disabled is stopped even while that process runs',
    specs: [{ kind: 'runner', enabled: false, act: 'start' }],
    expect: 'stopped',
  },
  {
    name: 'a disabled crashed process does not drag the application to failed',
    specs: [{ kind: 'crasher', enabled: false, act: 'start' }, { kind: 'runner' }],
    expect: 'stopped',
  },
  {
    name: 'a disabled running process does not make a stopped application partial',
    specs: [{ kind: 'runner', enabled: false, act: 'start' }, { kind: 'runner' }],
    expect: 'stopped',
  },
  {
    name: 'every enabled process running is running',
    specs: [{ kind: 'runner', act: 'start' }, { kind: 'runner', act: 'start' }],
    expect: 'running',
  },
  {
    name: 'a running process alongside a disabled one is still running',
    specs: [{ kind: 'runner', act: 'start' }, { kind: 'runner', enabled: false }],
    expect: 'running',
  },
  {
    name: 'one enabled process running and one never started is partial',
    specs: [{ kind: 'runner', act: 'start' }, { kind: 'runner' }],
    expect: 'partial',
  },
  {
    name: 'one running and one crashed is partial, not failed',
    specs: [{ kind: 'runner', act: 'start' }, { kind: 'crasher', act: 'start' }],
    expect: 'partial',
  },
  {
    name: 'a crashed process with none running is failed',
    specs: [{ kind: 'crasher', act: 'start' }, { kind: 'runner' }],
    expect: 'failed',
  },
  {
    name: 'a process that could not be spawned at all is failed',
    specs: [{ kind: 'broken', act: 'start', startThrows: true }],
    expect: 'failed',
  },
  {
    name: 'a starting process outranks running and crashed',
    specs: [
      { kind: 'runner', act: 'start' },
      { kind: 'crasher', act: 'start' },
      { kind: 'runner', act: 'starting' },
    ],
    expect: 'starting',
  },
  {
    name: 'a stopping process outranks running',
    specs: [{ kind: 'runner', act: 'start' }, { kind: 'stubborn', act: 'stopping' }],
    expect: 'stopping',
  },
  {
    name: 'a stopping process outranks starting',
    specs: [{ kind: 'stubborn', act: 'stopping' }, { kind: 'runner', act: 'starting' }],
    expect: 'stopping',
  },
];

async function buildRow(specs) {
  const prepared = [];
  for (const [index, spec] of specs.entries()) {
    const name = `${spec.kind}-${index}`;
    const repositoryPath = spec.kind === 'broken'
      ? await fs.mkdtemp(path.join(DATA_DIR, 'vanishing-'))
      : REPO_DIR;
    prepared.push({ ...spec, name, repositoryPath, command: COMMANDS[spec.kind](name) });
  }
  const app = await createApp(prepared);
  for (const spec of prepared) {
    if (spec.kind === 'broken') await fs.rm(spec.repositoryPath, { recursive: true, force: true });
  }
  return { app, prepared };
}

/** @returns {Promise<Promise<unknown>[]>} the transitions still in flight when the row is asserted */
async function arrangeRow(app, prepared) {
  const settled = prepared.filter((s) => s.act === 'start' || s.act === 'stopping');
  for (const spec of settled) {
    const { id } = app.processes.find((p) => p.name === spec.name);
    const started = service.startProcess(app.id, id);
    if (spec.startThrows) await assert.rejects(started);
    else await started;
  }

  const pending = [];
  for (const spec of prepared.filter((s) => s.act === 'starting')) {
    const { id } = app.processes.find((p) => p.name === spec.name);
    pending.push(service.startProcess(app.id, id).catch(() => {}));
    await waitForProcessStatus(app.id, id, 'starting');
  }
  for (const spec of prepared.filter((s) => s.act === 'stopping')) {
    const { id } = app.processes.find((p) => p.name === spec.name);
    pending.push(service.stopProcess(app.id, id).catch(() => {}));
    await waitForProcessStatus(app.id, id, 'stopping');
  }
  return pending;
}

for (const row of PRECEDENCE_ROWS) {
  suite(`application status: ${row.name}`, async (t) => {
    const { app, prepared } = await buildRow(row.specs);
    t.after(() => dispose(app.id));

    const pending = await arrangeRow(app, prepared);
    const view = await viewOf(app.id);
    await Promise.all(pending);

    assert.equal(
      view.status,
      row.expect,
      `expected ${row.expect} from [${view.processes.map((p) => `${p.name}=${p.status}` +
        `${p.enabled ? '' : ' (disabled)'}`).join(', ')}]`
    );
  });
}

// --- process counts --------------------------------------------------------------------------

suite('processCounts counts a disabled process in total but not in enabled', async (t) => {
  const app = await createApp([
    { name: 'up', command: COMMANDS.runner('up') },
    { name: 'dead', command: COMMANDS.crasher('dead') },
    { name: 'idle', command: COMMANDS.runner('idle') },
    { name: 'off', command: COMMANDS.runner('off'), enabled: false },
  ]);
  t.after(() => dispose(app.id));

  await service.startProcess(app.id, app.processes[0].id);
  await service.startProcess(app.id, app.processes[1].id);

  const view = await viewOf(app.id);
  assert.deepEqual(view.processCounts, {
    total: 4,
    enabled: 3,
    running: 1,
    stopped: 2,
    crashed: 1,
    failed: 0,
  });
  assert.deepEqual(
    view.processes.map((p) => p.status),
    ['running', 'crashed', 'stopped', 'stopped'],
    'the counts must describe the processes actually in the view'
  );
});

// --- process view shape ----------------------------------------------------------------------

// `ports` is decorated from the last port scan: null before one has happened, and an array of the
// ports this process was found listening on after.
const PROCESS_VIEW_KEYS = [
  'command', 'enabled', 'env', 'exitCode', 'exitSignal', 'favicon', 'id', 'lastError', 'name', 'pid', 'ports',
  'repositoryPath', 'restarts', 'startedAt', 'status', 'stoppedAt', 'uptimeMs', 'workingDirectory',
];

suite('ProcessView is the config fields plus the flattened runtime state', async (t) => {
  const app = await createApp([{ name: 'shape', command: COMMANDS.runner('shape') }]);
  t.after(() => dispose(app.id));
  const [proc] = app.processes;

  assert.deepEqual(Object.keys(proc).sort(), PROCESS_VIEW_KEYS);
  assert.deepEqual(
    {
      name: proc.name,
      repositoryPath: proc.repositoryPath,
      command: proc.command,
      workingDirectory: proc.workingDirectory,
      env: proc.env,
      enabled: proc.enabled,
    },
    {
      name: 'shape',
      repositoryPath: REPO_DIR,
      command: COMMANDS.runner('shape'),
      workingDirectory: REPO_DIR,
      env: {},
      enabled: true,
    }
  );
  assert.deepEqual(
    {
      status: proc.status, pid: proc.pid, startedAt: proc.startedAt, stoppedAt: proc.stoppedAt,
      exitCode: proc.exitCode, exitSignal: proc.exitSignal, lastError: proc.lastError,
      restarts: proc.restarts, uptimeMs: proc.uptimeMs,
    },
    {
      status: 'stopped', pid: null, startedAt: null, stoppedAt: null, exitCode: null,
      exitSignal: null, lastError: null, restarts: 0, uptimeMs: null
    }
  );

  await service.startProcess(app.id, proc.id);
  const running = await processOf(app.id, proc.id);
  assert.equal(running.status, 'running');
  assert.equal(Number.isInteger(running.pid) && running.pid > 0, true, 'pid must be a real pid');
  assert.equal(typeof running.uptimeMs, 'number');
  assert.equal(running.uptimeMs >= SETTLE_MS - 100, true, `uptimeMs was ${running.uptimeMs}`);
  assert.match(running.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  await service.stopProcess(app.id, proc.id);
  const stopped = await processOf(app.id, proc.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.uptimeMs, null, 'uptimeMs is null once the process is no longer running');
});

suite('ProcessView keeps an explicit workingDirectory and reports the configured env', async (t) => {
  const app = await createApp([{ name: 'nested', command: 'true' }]);
  t.after(() => dispose(app.id));

  const view = await service.updateProcess(app.id, app.processes[0].id, {
    workingDirectory: SUB_DIR,
    env: { API_PORT: 4000, DEBUG: 'true' },
  });
  const [proc] = view.processes;
  assert.equal(proc.workingDirectory, SUB_DIR);
  assert.equal(proc.repositoryPath, REPO_DIR);
  assert.deepEqual(proc.env, { API_PORT: '4000', DEBUG: 'true' });
});

// --- startApplication ------------------------------------------------------------------------

suite('startApplication starts enabled processes in order, skips disabled, and survives a crash',
  async (t) => {
    const app = await createApp([
      { name: 'first', command: COMMANDS.crasher('first') },
      { name: 'second', command: COMMANDS.runner('second') },
      { name: 'skipped', command: COMMANDS.runner('skipped'), enabled: false },
      { name: 'third', command: COMMANDS.runner('third') },
    ]);
    t.after(() => dispose(app.id));

    const { application, results } = await service.startApplication(app.id);

    assert.deepEqual(results.map((r) => r.name), ['first', 'second', 'third'],
      'one result per attempted process, in configured order, with the disabled one skipped');
    assert.deepEqual(results.map((r) => r.processId), [
      app.processes[0].id, app.processes[1].id, app.processes[3].id,
    ]);
    assert.deepEqual(results.map((r) => r.ok), [false, true, true]);
    assert.deepEqual(results.map((r) => r.status), ['crashed', 'running', 'running']);
    assert.match(results[0].error, /exited with code 3 during startup/);
    assert.equal(results[1].error, null);
    assert.equal(results[2].error, null);

    const skipped = application.processes.find((p) => p.name === 'skipped');
    assert.deepEqual(
      { status: skipped.status, pid: skipped.pid, startedAt: skipped.startedAt },
      { status: 'stopped', pid: null, startedAt: null },
      'a disabled process must not be touched by an application start'
    );
    assert.equal(application.status, 'partial');

    // The start order is observable in the log: the global seq is assigned as each line arrives.
    const logs = await service.readLogs({ applicationId: app.id });
    assert.deepEqual(logs.entries.map((e) => e.message), ['first', 'second', 'third']);
  });

// --- autoStartApplications -------------------------------------------------------------------

suite('autoStartApplications starts only the applications marked to, in order, and survives a crash',
  async (t) => {
    const crashing = await createApp([{ name: 'boom', command: COMMANDS.crasher('boom') }]);
    const unmarked = await createApp([{ name: 'idle', command: COMMANDS.runner('idle') }]);
    const marked = await createApp([
      { name: 'web', command: COMMANDS.runner('web') },
      { name: 'off', command: COMMANDS.runner('off'), enabled: false },
    ]);
    t.after(() => Promise.all([crashing, unmarked, marked].map((app) => dispose(app.id))));
    await service.updateApplication(crashing.id, { autoStart: true });
    await service.updateApplication(marked.id, { autoStart: true });

    const outcomes = await service.autoStartApplications();

    assert.deepEqual(
      outcomes.map((o) => ({ id: o.applicationId, statuses: o.results.map((r) => `${r.name}:${r.status}`) })),
      [
        { id: crashing.id, statuses: ['boom:crashed'] },
        { id: marked.id, statuses: ['web:running'] },
      ],
      'marked applications only, in configured order, and a crash in the first does not stop the second'
    );
    assert.equal((await viewOf(unmarked.id)).processes[0].status, 'stopped');
    assert.equal(
      (await viewOf(marked.id)).processes.find((p) => p.name === 'off').status,
      'stopped',
      'a disabled process stays down, exactly as a click on Start leaves it'
    );
    assert.equal((await viewOf(marked.id)).autoStart, true);
  });

// --- stopApplication -------------------------------------------------------------------------

const trapper = (name) => `trap 'echo ${name}-term; exit 0' TERM; sleep ${LONG}`;

suite('stopApplication stops in reverse order and stops disabled-but-running processes too',
  async (t) => {
    const app = await createApp([
      { name: 'alpha', command: trapper('alpha') },
      { name: 'beta', command: trapper('beta'), enabled: false },
      { name: 'gamma', command: trapper('gamma') },
    ]);
    t.after(() => dispose(app.id));

    await service.startApplication(app.id);
    await service.startProcess(app.id, app.processes[1].id);

    const started = await viewOf(app.id);
    assert.deepEqual(started.processes.map((p) => p.status), ['running', 'running', 'running']);
    const pids = started.processes.map((p) => p.pid);

    const { application, results } = await service.stopApplication(app.id);

    assert.deepEqual(results.map((r) => r.name), ['gamma', 'beta', 'alpha'],
      'reverse configured order, disabled process included');
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.deepEqual(results.map((r) => r.status), ['stopped', 'stopped', 'stopped']);
    assert.deepEqual(application.processes.map((p) => p.status),
      ['stopped', 'stopped', 'stopped']);
    assert.equal(application.status, 'stopped');
    assert.deepEqual(pids.map((pid) => treeAlive(pid)), [false, false, false],
      'stop resolves only once each process group is confirmed gone');

    const logs = await service.readLogs({ applicationId: app.id });
    assert.deepEqual(
      logs.entries.map((e) => e.message).filter((m) => m.endsWith('-term')),
      ['gamma-term', 'beta-term', 'alpha-term'],
      'the processes themselves saw SIGTERM in reverse configured order'
    );
  });

// --- updateProcess ---------------------------------------------------------------------------

suite('updateProcess leaves a running process running and marks configChangedWhileRunning',
  async (t) => {
    const app = await createApp([{ name: 'live', command: COMMANDS.runner('live') }]);
    t.after(() => dispose(app.id));
    const { id } = app.processes[0];

    await service.startProcess(app.id, id);
    const before = await processOf(app.id, id);

    const view = await service.updateProcess(app.id, id, { command: `sleep ${LONG + 1}` });
    const updated = view.processes.find((p) => p.id === id);

    assert.equal(updated.command, `sleep ${LONG + 1}`);
    assert.equal(updated.configChangedWhileRunning, true);
    assert.equal(updated.status, 'running');
    assert.equal(updated.pid, before.pid, 'the child was not replaced');
    assert.equal(updated.startedAt, before.startedAt, 'the child was not restarted');
    assert.equal(updated.restarts, 0);
    assert.equal(treeAlive(before.pid), true, 'the original process group is still alive');
  });

suite('updateProcess does not mark configChangedWhileRunning on a process that is not active',
  async (t) => {
    const app = await createApp([{ name: 'idle', command: COMMANDS.runner('idle') }]);
    t.after(() => dispose(app.id));
    const { id } = app.processes[0];

    await service.startProcess(app.id, id);
    await service.stopProcess(app.id, id);

    const view = await service.updateProcess(app.id, id, { command: 'sleep 1' });
    const updated = view.processes.find((p) => p.id === id);
    assert.equal(updated.command, 'sleep 1');
    assert.equal(updated.configChangedWhileRunning, undefined);
    assert.equal(updated.status, 'stopped');
  });

// --- deletion --------------------------------------------------------------------------------

suite('deleteApplication stops its processes, forgets their runtime and clears their logs',
  async (t) => {
    const app = await createApp([{ name: 'doomed', command: COMMANDS.runner('doomed') }]);
    t.after(() => dispose(app.id));
    const { id: processId } = app.processes[0];

    await service.startApplication(app.id);
    const running = await processOf(app.id, processId);
    const { pid } = running;
    assert.equal(running.status, 'running');
    assert.deepEqual(
      (await service.readLogs({ applicationId: app.id })).entries.map((e) => e.message),
      ['doomed']
    );

    const removed = await service.deleteApplication(app.id);

    assert.equal(removed.id, app.id);
    assert.equal(removed.status, 'stopped');
    assert.deepEqual(removed.processes.map((p) => ({ status: p.status, pid: p.pid })),
      [{ status: 'stopped', pid: null }]);
    assert.equal(treeAlive(pid), false, 'the deleted application must not leave a live group');
    await assert.rejects(viewOf(app.id), { name: 'NotFoundError' });
    assert.deepEqual(
      logStore.read({ applicationId: app.id, processIds: [processId] }).entries, [],
      'the log buffer of a deleted application is cleared'
    );
  });

suite('removeProcess stops that process, clears its logs, and leaves its siblings alone',
  async (t) => {
    const app = await createApp([
      { name: 'keeper', command: COMMANDS.runner('keeper') },
      { name: 'goner', command: COMMANDS.runner('goner') },
    ]);
    t.after(() => dispose(app.id));
    const [keeper, goner] = app.processes;

    await service.startApplication(app.id);
    const before = await viewOf(app.id);
    const gonerPid = before.processes.find((p) => p.id === goner.id).pid;
    const keeperPid = before.processes.find((p) => p.id === keeper.id).pid;

    const view = await service.removeProcess(app.id, goner.id);

    assert.deepEqual(view.processes.map((p) => p.name), ['keeper']);
    assert.equal(treeAlive(gonerPid), false, 'the removed process must be dead');
    assert.equal(treeAlive(keeperPid), true, 'its sibling must be untouched');
    assert.equal(view.processes[0].pid, keeperPid);
    assert.equal(view.status, 'running');
    assert.deepEqual(
      logStore.read({ applicationId: app.id, processIds: [goner.id] }).entries, [],
      'the removed process log buffer is cleared'
    );
    assert.deepEqual(
      (await service.readLogs({ applicationId: app.id })).entries.map((e) => e.message),
      ['keeper'],
      'the surviving process keeps its log'
    );
  });

// --- readLogs --------------------------------------------------------------------------------

suite('readLogs resolves processName on every entry and names the application', async (t) => {
  const app = await createApp([
    { name: 'api', command: 'echo api-line; sleep ' + LONG },
    { name: 'web', command: 'echo web-line 1>&2; sleep ' + LONG },
  ]);
  t.after(() => dispose(app.id));
  const [api, web] = app.processes;

  await service.startApplication(app.id);

  const all = await service.readLogs({ applicationId: app.id });
  assert.deepEqual(all.application, { id: app.id, name: app.name });
  assert.equal(all.process, null);
  assert.equal(all.dropped, false);
  assert.deepEqual(
    all.entries.map((e) => ({ processId: e.processId, processName: e.processName,
      stream: e.stream, message: e.message })),
    [
      { processId: api.id, processName: 'api', stream: 'stdout', message: 'api-line' },
      { processId: web.id, processName: 'web', stream: 'stderr', message: 'web-line' },
    ]
  );
  assert.deepEqual(Object.keys(all.entries[0]).sort(),
    ['message', 'processId', 'processName', 'seq', 'stream', 'ts']);
  assert.equal(all.nextSeq, all.entries.at(-1).seq + 1, 'nextSeq is a usable cursor');

  const one = await service.readLogs({ applicationId: app.id, processId: web.id });
  assert.deepEqual(one.process, { id: web.id, name: 'web' });
  assert.deepEqual(one.entries.map((e) => e.message), ['web-line']);
  assert.equal(one.entries[0].processName, 'web');

  const filtered = await service.readLogs({ applicationId: app.id, stream: 'stderr' });
  assert.deepEqual(filtered.entries.map((e) => e.processName), ['web']);

  const since = await service.readLogs({ applicationId: app.id, sinceSeq: all.nextSeq });
  assert.deepEqual(since.entries, []);
  assert.equal(since.dropped, false);

  await assert.rejects(service.readLogs({ applicationId: app.id, processId: 'proc_missing' }),
    { name: 'NotFoundError' });
});

// --- favicons --------------------------------------------------------------------------------

/** A free loopback port, found by letting the OS pick one and handing it straight back. */
async function freePort() {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const ICON_SERVER = `
const http = require('http');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
http.createServer((req, res) => {
  if (req.url === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<link rel="icon" href="/icon.svg">');
}).listen(Number(process.argv[2]), '0.0.0.0');
`;

// Through the real path end to end — a spawned service, an OS port scan, correlation, discovery —
// because the favicons unit suite builds its targets by hand, and a hand-built target once hid a
// shape mismatch with what a scan actually produces.
suite('a running service that serves a favicon gets it on its view, and loses it on removal',
  async (t) => {
    await fs.writeFile(path.join(REPO_DIR, 'icon-server.cjs'), ICON_SERVER);
    const port = await freePort();
    const app = await createApp([{ name: 'web', command: `node icon-server.cjs ${port}` }]);
    t.after(() => dispose(app.id));
    const { id } = app.processes[0];

    let refetches = 0;
    const onApplications = () => (refetches += 1);
    service.events.on('applications', onApplications);
    t.after(() => service.events.off('applications', onApplications));

    await service.startProcess(app.id, id);
    const view = await waitFor(async () => {
      await service.listPorts({ force: true });
      const proc = await processOf(app.id, id);
      return proc.favicon ? proc : null;
    }, 'the favicon to be discovered', 20_000);

    assert.equal(view.favicon.sourceUrl, `http://127.0.0.1:${port}/icon.svg`);
    assert.ok(refetches > 0, 'dashboards are told to refetch when an icon lands');
    const { favicons } = await service.listFavicons();
    assert.match(favicons[id].dataUrl, /^data:image\/svg\+xml;base64,/);

    await service.removeProcess(app.id, id);
    assert.deepEqual((await service.listFavicons()).favicons, {});
  });

// --- PostgreSQL applications -----------------------------------------------------------------

/** A directory that passes validation without a server behind it — enough for view and refusal tests. */
async function fakeCluster() {
  const dir = path.join(DATA_DIR, unique('fake-cluster'));
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'PG_VERSION'), '16\n');
  return dir;
}

suite('a PostgreSQL application is one derived postgres server, and its view never carries the password',
  async (t) => {
    const dataDirectory = await fakeCluster();
    const app = await service.createApplication({
      name: unique('pg-view'),
      kind: 'postgres',
      postgres: { dataDirectory, port: 6543, user: 'dev', password: 'hunter2' },
    });
    t.after(() => dispose(app.id));

    assert.equal(app.kind, 'postgres');
    assert.deepEqual(app.postgres, {
      dataDirectory,
      port: 6543,
      binDirectory: null,
      user: 'dev',
      maintenanceDatabase: 'postgres',
      logFile: null,
      host: 'localhost',
      passwordSet: true,
    });
    assert.equal(JSON.stringify(app).includes('hunter2'), false, 'the password leaked into the view');

    assert.equal(app.processes.length, 1);
    const [server] = app.processes;
    assert.equal(server.id, 'postgres');
    const logFile = path.join(DATA_DIR, 'logs', app.id, 'postgresql.log');
    assert.equal(server.command, `pg_ctl start -D ${dataDirectory} -l ${logFile} -o "-p 6543"`);
    // Never started and no postmaster.pid: stopped, with nothing to say about it.
    assert.equal(server.status, 'stopped');
    assert.equal(server.pid, null);
    assert.deepEqual(app.processCounts, { total: 1, enabled: 1, running: 0, stopped: 1, crashed: 0, failed: 0 });
  });

suite('a PostgreSQL application named before its server is defined runs nothing until it is', async (t) => {
  const app = await service.createApplication({ name: unique('pg-undefined'), kind: 'postgres' });
  t.after(() => dispose(app.id));

  assert.equal(app.postgres, null);
  assert.deepEqual(app.processes, []);
  assert.equal(app.status, 'stopped');
  const { results } = await service.startApplication(app.id);
  assert.deepEqual(results, []);
  await assert.rejects(service.listDatabases(app.id), (err) => {
    assert.equal(err.name, 'ValidationError');
    assert.match(err.message, /not defined yet/);
    return true;
  });

  const defined = await service.updateApplication(app.id, { postgres: { dataDirectory: await fakeCluster() } });
  assert.equal(defined.postgres.port, 5432);
  assert.equal(defined.processes.length, 1);
  assert.equal(defined.processes[0].id, 'postgres');
  assert.equal(defined.processes[0].configChangedWhileRunning, undefined);
});

suite('the database tools refuse an application that is not a PostgreSQL one', async (t) => {
  const app = await createApp([]);
  t.after(() => dispose(app.id));
  await assert.rejects(service.listDatabases(app.id), (err) => {
    assert.equal(err.name, 'ValidationError');
    assert.match(err.message, /not a PostgreSQL application/);
    return true;
  });
});

// The data directory belongs to this run alone; leaving it behind accumulates one
// directory per run in the system temp folder.
after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
