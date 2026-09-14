/**
 * Start at login. Two layers, tested the way each can be:
 *
 *  - `problemsOf` is pure, and every way an entry goes stale is a case below;
 *  - the platform entries are really written — into a temp home under a unique label, so a run can
 *    never touch the developer's own LaunchAgents or autostart directory, and is never loaded. Paths
 *    in the spec carry spaces, quotes, `$` and `&` on purpose: an entry is a file another program
 *    parses at login, where a quoting mistake fails with nobody watching.
 *
 * Nothing here loads a job or edits the Windows registry; the win32 entry needs its own run on Windows.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-login-item-')));
process.env.PADDOCK_DATA_DIR = path.join(tmpRoot, 'data');

const { problemsOf } = await import('../login-item.js');
const platform = await import('../platform/index.js');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('problemsOf', () => {
  const spec = { workingDirectory: '/here/paddock', program: '/node/v24/bin/node' };
  const record = { workingDirectory: '/here/paddock', program: '/node/v24/bin/node', args: [], writtenAt: 'x' };

  test('nothing installed is nothing to fix', () => {
    assert.deepEqual(problemsOf({ installed: false, record: null, spec, programExists: false }), []);
  });

  test('an entry that starts this copy with a node that exists is healthy', () => {
    assert.deepEqual(problemsOf({ installed: true, record, spec, programExists: true }), []);
  });

  test('an entry Paddock did not write is reported as unknown, not assumed fine', () => {
    const [problem] = problemsOf({ installed: true, record: null, spec, programExists: false });
    assert.match(problem, /not written by Paddock/);
  });

  test('an entry pointing at another checkout names that checkout', () => {
    const moved = { ...record, workingDirectory: '/old/paddock' };
    const [problem] = problemsOf({ installed: true, record: moved, spec, programExists: true });
    assert.match(problem, /\/old\/paddock/);
  });

  test('a node binary removed since (an nvm uninstall) is named', () => {
    const [problem] = problemsOf({ installed: true, record, spec, programExists: false });
    assert.match(problem, /\/node\/v24\/bin\/node/);
  });

  test('a different node that still exists is not a problem: it was the one that worked', () => {
    const newer = { ...spec, program: '/node/v26/bin/node' };
    assert.deepEqual(problemsOf({ installed: true, record, spec: newer, programExists: true }), []);
  });
});

describe('platform entry', { skip: IS_WIN && 'the win32 entry writes to the registry' }, () => {
  /** Hostile on purpose — every character an entry format might need to escape. */
  const hostile = path.join(tmpRoot, `it's a "dir" & $HOME`);
  let spec;

  before(async () => {
    await fs.mkdir(hostile, { recursive: true });
    spec = {
      label: `local.paddock.test-${process.pid}`,
      home: path.join(tmpRoot, 'home'),
      program: path.join(hostile, 'fake-node'),
      args: [path.join(hostile, 'server.js')],
      workingDirectory: hostile,
      logFile: path.join(hostile, 'logs', 'paddock.log'),
      launcherDir: path.join(tmpRoot, 'data'),
      env: { PADDOCK_LOGIN_ITEM: '1' },
    };
    // The Linux entry reads XDG_CONFIG_HOME; the developer's own must not redirect it out of tmp.
    delete process.env.XDG_CONFIG_HOME;
  });

  test('is reported as not installed before it is written', async () => {
    const status = await platform.loginItemStatus(spec);
    assert.equal(status.supported, true);
    assert.equal(status.installed, false);
    assert.ok(status.location.startsWith(spec.home), `entry must live under the given home: ${status.location}`);
  });

  test('is installed, and removed again', async () => {
    await platform.installLoginItem(spec);
    assert.equal((await platform.loginItemStatus(spec)).installed, true);

    await platform.removeLoginItem(spec);
    assert.equal((await platform.loginItemStatus(spec)).installed, false);
  });

  test('installing twice replaces the entry rather than failing', async () => {
    await platform.installLoginItem(spec);
    await platform.installLoginItem({ ...spec, args: [path.join(hostile, 'other.js')] });
    const { location } = await platform.loginItemStatus(spec);
    // macOS keeps the command in the entry itself; Linux's desktop entry only names a launcher.
    const command = IS_MAC ? location : path.join(spec.launcherDir, 'paddock-login.sh');
    assert.match(await fs.readFile(command, 'utf8'), /other\.js/);
    await platform.removeLoginItem(spec);
  });

  test('macOS: the plist parses, and every hostile path survives exactly', { skip: !IS_MAC && 'macOS only' }, async () => {
    await platform.installLoginItem(spec);
    const { location } = await platform.loginItemStatus(spec);
    await run('/usr/bin/plutil', ['-lint', location]);
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', location]);
    const plist = JSON.parse(stdout);

    assert.equal(plist.Label, spec.label);
    assert.deepEqual(plist.ProgramArguments, [spec.program, ...spec.args]);
    assert.equal(plist.WorkingDirectory, hostile);
    assert.equal(plist.StandardOutPath, spec.logFile);
    assert.equal(plist.EnvironmentVariables.PADDOCK_LOGIN_ITEM, '1');
    assert.ok(
      plist.EnvironmentVariables.PATH.startsWith(`${hostile}:`),
      'PATH must lead with the directory of the node it runs, so `npm` resolves for managed services'
    );
    assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
    await platform.removeLoginItem(spec);
  });

  test('Linux: the launcher runs the program in the right directory with the right environment', { skip: (IS_MAC || IS_WIN) && 'Linux only' }, async () => {
    // A stand-in for node that records what it was started with, one value per line — the values
    // are the hostile paths themselves, so they are written raw rather than into a format to escape.
    const witness = path.join(tmpRoot, 'witness.txt');
    await fs.writeFile(
      spec.program,
      `#!/bin/sh\nprintf '%s\\n' "$(pwd)" "$1" "$PADDOCK_LOGIN_ITEM" > '${witness}'\n`,
      { mode: 0o755 }
    );
    await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
    await platform.installLoginItem(spec);

    await run(path.join(spec.launcherDir, 'paddock-login.sh'));
    const [cwd, arg, env] = (await fs.readFile(witness, 'utf8')).split('\n');
    assert.deepEqual({ cwd, arg, env }, { cwd: hostile, arg: spec.args[0], env: '1' });

    const { location } = await platform.loginItemStatus(spec);
    assert.match(await fs.readFile(location, 'utf8'), /^Exec="/m);
    await platform.removeLoginItem(spec);
  });
});
