/**
 * Terminal runtime and the service facade over it.
 *
 * Target derivation and refusals run everywhere. Open, write, replay and close need a working
 * node-pty binding — skipped when `ptyAvailability()` says there is none, so CI without a
 * toolchain does not fail over an optional feature.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-term-'));
const REPO_A = path.join(DATA_DIR, 'repo-a');
const REPO_B = path.join(DATA_DIR, 'repo-b');
const SUB_A = path.join(REPO_A, 'packages', 'api');
await fs.mkdir(SUB_A, { recursive: true });
await fs.mkdir(REPO_B, { recursive: true });

process.env.PADDOCK_DATA_DIR = DATA_DIR;
process.env.PADDOCK_ENV_FILE = path.join(DATA_DIR, 'absent.env');
process.env.PADDOCK_LOG_PERSIST = 'false';
process.env.PADDOCK_REAP_ORPHANS = 'false';
process.env.PADDOCK_TERMINAL_IDLE_TIMEOUT_MS = '900000';

const platform = await import('../platform/index.js');
const { available: ptyAvailable, reason: ptyReason } = await platform.ptyAvailability();
const service = await import('../service.js');
const terminals = await import('../terminal-manager.js');
const { NotFoundError, ValidationError } = await import('../applications.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
const unique = (prefix) => `${prefix}-${++counter}`;

async function appWithProcesses() {
  const app = await service.createApplication({ name: unique('term') });
  await service.addProcess(app.id, {
    name: 'api',
    repositoryPath: REPO_A,
    workingDirectory: SUB_A,
    command: 'sleep 30',
  });
  await service.addProcess(app.id, {
    name: 'web',
    repositoryPath: REPO_A,
    command: 'sleep 30',
  });
  // Same directory as web — must not appear as a second target.
  await service.addProcess(app.id, {
    name: 'worker',
    repositoryPath: REPO_A,
    command: 'sleep 30',
  });
  await service.addProcess(app.id, {
    name: 'other',
    repositoryPath: REPO_B,
    command: 'sleep 30',
  });
  return app.id;
}

test('terminal targets dedupe by directory and honour workingDirectory', async () => {
  const appId = await appWithProcesses();
  const { targets } = await service.listTerminals(appId);
  assert.equal(targets.length, 3);
  const api = targets.find((t) => t.processName === 'api');
  const web = targets.find((t) => t.processName === 'web');
  const other = targets.find((t) => t.processName === 'other');
  assert.equal(api.cwd, SUB_A);
  assert.equal(web.cwd, REPO_A);
  assert.equal(other.cwd, REPO_B);
  assert.equal(targets.some((t) => t.processName === 'worker'), false);
  await service.deleteApplication(appId);
});

test('openTerminal refuses an unknown process id', async () => {
  const appId = await appWithProcesses();
  await assert.rejects(
    () => service.openTerminal(appId, { processId: 'proc_does_not_exist' }),
    NotFoundError
  );
  await service.deleteApplication(appId);
});

test('openTerminal refuses an application with no processes', async () => {
  const app = await service.createApplication({ name: unique('empty') });
  await assert.rejects(
    () => service.openTerminal(app.id, {}),
    ValidationError
  );
  await service.deleteApplication(app.id);
});

test(
  'open, write, replay scrollback, and close a terminal session',
  { skip: ptyAvailable ? false : ptyReason ?? 'no pseudo-terminal support' },
  async () => {
    const appId = await appWithProcesses();
    const { targets } = await service.listTerminals(appId);
    const session = await service.openTerminal(appId, {
      processId: targets[0].processId,
      cols: 80,
      rows: 24,
    });
    assert.match(session.id, /^[0-9a-f-]{36}$/);
    assert.equal(session.running, true);

    const live = [];
    const unsub = terminals.subscribe(session.id, {
      onData: (chunk) => live.push(chunk),
      onExit: () => {},
    });

    await sleep(400);
    service.writeTerminal(session.id, 'printf paddock-terminal-test\\n');
    await sleep(600);
    unsub();

    const joined = live.join('');
    assert.match(joined, /paddock-terminal-test/);

    const replay = [];
    terminals.subscribe(session.id, {
      onData: (chunk) => replay.push(chunk),
      onExit: () => {},
    });
    assert.match(replay.join(''), /paddock-terminal-test/);

    await service.closeTerminal(session.id);
    assert.equal(terminals.get(session.id), null);
    await service.deleteApplication(appId);
  }
);

after(async () => {
  await terminals.closeAll();
});
