/**
 * Regression suite for applications.js — the configuration domain. Everything here goes through the
 * public exports; nothing reaches into module state. The data directory is a fresh mkdtemp per run,
 * set on `process.env` before the first dynamic import because config.js resolves DATA_DIR at import
 * time, so the suite can never see or touch a developer's real applications.json.
 *
 * The path fixtures are real directories: containment is a security control and the module checks it
 * against the filesystem (realpath included), so a stubbed path would test nothing.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLICATIONS_URL = pathToFileURL(path.join(PROJECT_ROOT, 'applications.js')).href;

/** @type {typeof import('../applications.js')} */
let apps;

/** Temp fixtures, all realpath'd so a macOS /var -> /private/var symlink cannot skew a comparison. */
let tmpRoot;
let dataDir;
let repo;
let subDir;
let siblingPrefixDir;
let outsideDir;
let regularFile;

let nameCounter = 0;

/** Every test owns its names: the suite shares one DB, and uniqueness is global for applications. */
const unique = (hint) => `${hint}-${(nameCounter += 1)}`;

/**
 * Assert the rejection's class and that its message names each fragment. These messages are the
 * user's only feedback, so "it threw" is not the assertion — "it said which value was wrong" is.
 */
const rejectsWith = (promise, ErrorClass, ...fragments) =>
  assert.rejects(promise, (err) => {
    assert.ok(
      err instanceof ErrorClass,
      `expected ${ErrorClass.name}, got ${err?.name}: ${err?.message}`
    );
    for (const fragment of fragments) {
      assert.ok(
        err.message.includes(fragment),
        `message ${JSON.stringify(err.message)} does not name ${JSON.stringify(fragment)}`
      );
    }
    return true;
  });

/**
 * ISO timestamps have millisecond resolution, so two writes in the same millisecond produce the same
 * string and `updatedAt >= before` would hold even for a module that never bumps it. Waiting for the
 * clock to tick past `iso` lets the bump assertions be strict without being timing-dependent: this
 * polls to a deadline instead of sleeping a guessed interval, and normally returns on the first tick.
 */
const afterTheClockTicksPast = async (iso) => {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= Date.parse(iso)) {
    assert.ok(Date.now() < deadline, `the clock did not advance past ${iso} within 1s`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const createApp = (hint = 'app', description) =>
  apps.createApplication({ name: unique(hint), description });

const processInput = (overrides = {}) => ({
  name: unique('proc'),
  repositoryPath: repo,
  command: 'npm run dev',
  ...overrides,
});

before(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-test-')));
  dataDir = path.join(tmpRoot, 'data');
  repo = path.join(tmpRoot, 'repo');
  subDir = path.join(repo, 'packages', 'api');
  siblingPrefixDir = path.join(tmpRoot, 'repo-evil');
  outsideDir = path.join(tmpRoot, 'elsewhere');
  regularFile = path.join(tmpRoot, 'not-a-directory.txt');

  await fs.mkdir(dataDir);
  await fs.mkdir(subDir, { recursive: true });
  await fs.mkdir(siblingPrefixDir);
  await fs.mkdir(outsideDir);
  await fs.writeFile(regularFile, 'not a directory\n');

  process.env.PADDOCK_DATA_DIR = dataDir;
  // config.js loads a .env next to itself when one exists. Already-set variables win over it, so the
  // data directory above is safe either way — but pinning the env file at a path that cannot exist
  // keeps every other setting at its default too, so a developer's local .env cannot change a result.
  process.env.PADDOCK_ENV_FILE = path.join(tmpRoot, 'no-such.env');
  apps = await import(APPLICATIONS_URL);
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('identifiers', () => {
  test('a new application gets an app_-prefixed id of 12 lowercase base36 characters', async () => {
    const app = await createApp('ids');
    assert.match(app.id, /^app_[0-9a-z]{12}$/);
  });

  test('a new process gets a proc_-prefixed id of 12 lowercase base36 characters', async () => {
    const app = await createApp('ids');
    const proc = await apps.addProcess(app.id, processInput());
    assert.match(proc.id, /^proc_[0-9a-z]{12}$/);
  });

  test('ids are distinct across applications and across processes', async () => {
    const created = await Promise.all([createApp('ids'), createApp('ids'), createApp('ids')]);
    const procs = await Promise.all([
      apps.addProcess(created[0].id, processInput()),
      apps.addProcess(created[0].id, processInput()),
      apps.addProcess(created[1].id, processInput()),
    ]);
    const ids = [...created.map((a) => a.id), ...procs.map((p) => p.id)];
    assert.equal(new Set(ids).size, 6, `ids collided: ${ids.join(', ')}`);
  });
});

describe('application CRUD', () => {
  test('createApplication normalises the name, defaults the description and starts with no processes', async () => {
    const name = unique('Spaced');
    const app = await apps.createApplication({ name: `  ${name}  ` });
    assert.equal(app.name, name);
    assert.equal(app.description, '');
    assert.deepEqual(app.processes, []);
    assert.equal(app.createdAt, app.updatedAt);
    assert.equal(new Date(app.createdAt).toISOString(), app.createdAt);
  });

  test('createApplication trims the description', async () => {
    const app = await apps.createApplication({ name: unique('desc'), description: '  storefront  ' });
    assert.equal(app.description, 'storefront');
  });

  test('getApplication returns the stored application and listApplications includes it', async () => {
    const app = await createApp('read');
    assert.deepEqual(await apps.getApplication(app.id), app);
    const listed = (await apps.listApplications()).find((a) => a.id === app.id);
    assert.deepEqual(listed, app);
  });

  test('updateApplication patches only the fields provided and preserves id and createdAt', async () => {
    const app = await apps.createApplication({ name: unique('before'), description: 'original' });
    const renamed = unique('after');
    await afterTheClockTicksPast(app.updatedAt);
    const updated = await apps.updateApplication(app.id, { name: renamed });
    assert.equal(updated.id, app.id);
    assert.equal(updated.name, renamed);
    assert.equal(updated.description, 'original');
    assert.equal(updated.createdAt, app.createdAt);
    // Strictly greater, not >=: the clock has been allowed to tick, so an unbumped updatedAt — which
    // is what a stale-cache bug looks like from the outside — cannot slip past as "equal is fine".
    assert.ok(
      Date.parse(updated.updatedAt) > Date.parse(app.updatedAt),
      `updatedAt was not bumped: ${app.updatedAt} -> ${updated.updatedAt}`
    );
    assert.deepEqual(await apps.getApplication(app.id), updated);
  });

  test('autoStart defaults to false, can be set on create and by update, and rejects a non-boolean', async () => {
    const plain = await createApp('autostart-default');
    assert.equal(plain.autoStart, false);

    const marked = await apps.createApplication({ name: unique('autostart-on'), autoStart: true });
    assert.equal(marked.autoStart, true);

    const off = await apps.updateApplication(marked.id, { autoStart: false });
    assert.equal(off.autoStart, false);
    assert.equal(off.name, marked.name, 'an autoStart patch touches nothing else');

    await rejectsWith(
      apps.createApplication({ name: unique('autostart-bad'), autoStart: 'yes' }),
      apps.ValidationError,
      'autoStart must be true or false',
      "'yes'"
    );
    await rejectsWith(
      apps.updateApplication(plain.id, { autoStart: 1 }),
      apps.ValidationError,
      'autoStart must be true or false'
    );
  });

  test('updateApplication with an empty patch leaves the name and description alone', async () => {
    const app = await apps.createApplication({ name: unique('untouched'), description: 'keep me' });
    const updated = await apps.updateApplication(app.id, {});
    assert.equal(updated.name, app.name);
    assert.equal(updated.description, 'keep me');
  });

  test('deleteApplication returns the removed application and removes only it', async () => {
    const doomed = await createApp('doomed');
    const survivor = await createApp('survivor');
    await apps.addProcess(doomed.id, processInput());

    const removed = await apps.deleteApplication(doomed.id);
    assert.equal(removed.id, doomed.id);
    assert.equal(removed.processes.length, 1);

    const ids = (await apps.listApplications()).map((a) => a.id);
    assert.ok(!ids.includes(doomed.id), 'deleted application is still listed');
    assert.ok(ids.includes(survivor.id), 'delete removed a sibling application too');
    await rejectsWith(apps.getApplication(doomed.id), apps.NotFoundError, doomed.id);
  });

  test('returned configurations are copies — mutating one cannot rewrite the store', async () => {
    const app = await createApp('copy');
    const fetched = await apps.getApplication(app.id);
    fetched.name = 'mutated-in-place';
    fetched.processes.push({ id: 'proc_injected' });
    const reread = await apps.getApplication(app.id);
    assert.equal(reread.name, app.name);
    assert.deepEqual(reread.processes, []);
  });

  test('listApplications hands out copies too, not the stored objects', async () => {
    const app = await createApp('listcopy');
    const listed = (await apps.listApplications()).find((a) => a.id === app.id);
    listed.name = 'mutated-in-place';
    listed.processes.push({ id: 'proc_injected' });
    const reread = (await apps.listApplications()).find((a) => a.id === app.id);
    assert.equal(reread.name, app.name);
    assert.deepEqual(reread.processes, []);
  });
});

describe('process CRUD', () => {
  test('addProcess stores the normalised process and attaches it to its application', async () => {
    const app = await createApp('procs');
    const name = unique('web');
    const proc = await apps.addProcess(
      app.id,
      processInput({ name: `  ${name}  `, command: '  npm run dev  ' })
    );

    assert.equal(proc.name, name);
    assert.equal(proc.command, 'npm run dev');
    assert.equal(proc.repositoryPath, repo);
    assert.equal(proc.workingDirectory, null);
    assert.deepEqual(proc.env, {});
    assert.equal(proc.enabled, true);
    assert.equal(proc.createdAt, proc.updatedAt);

    const stored = await apps.getApplication(app.id);
    assert.deepEqual(stored.processes, [proc]);
  });

  test('enabled defaults to true, accepts false and rejects a non-boolean', async () => {
    const app = await createApp('enabled');
    const off = await apps.addProcess(app.id, processInput({ enabled: false }));
    assert.equal(off.enabled, false);
    await rejectsWith(
      apps.addProcess(app.id, processInput({ enabled: 'yes' })),
      apps.ValidationError,
      'enabled must be true or false',
      "'yes'"
    );
  });

  test('updateProcess patches only the fields provided and preserves id and createdAt', async () => {
    const app = await createApp('patch');
    const proc = await apps.addProcess(app.id, processInput({ command: 'npm start' }));
    const updated = await apps.updateProcess(app.id, proc.id, { command: 'npm run dev -- --port 0' });

    assert.equal(updated.id, proc.id);
    assert.equal(updated.name, proc.name);
    assert.equal(updated.command, 'npm run dev -- --port 0');
    assert.equal(updated.repositoryPath, proc.repositoryPath);
    assert.equal(updated.createdAt, proc.createdAt);

    const stored = await apps.getApplication(app.id);
    assert.deepEqual(stored.processes, [updated]);
  });

  test('removeProcess returns the removed process and leaves its siblings', async () => {
    const app = await createApp('remove');
    const first = await apps.addProcess(app.id, processInput());
    const second = await apps.addProcess(app.id, processInput());

    const removed = await apps.removeProcess(app.id, first.id);
    assert.equal(removed.id, first.id);

    const stored = await apps.getApplication(app.id);
    assert.deepEqual(
      stored.processes.map((p) => p.id),
      [second.id]
    );
  });

  test('the process returned by addProcess is a copy, not the stored configuration', async () => {
    const app = await createApp('proccopy');
    const proc = await apps.addProcess(app.id, processInput());
    proc.command = 'rm -rf /';
    proc.env.INJECTED = 'yes';
    const stored = (await apps.getApplication(app.id)).processes[0];
    assert.equal(stored.command, 'npm run dev');
    assert.deepEqual(stored.env, {});
  });

  test('adding and removing a process bumps its application updatedAt', async () => {
    const app = await createApp('bump');
    await afterTheClockTicksPast(app.updatedAt);
    const proc = await apps.addProcess(app.id, processInput());
    const afterAdd = await apps.getApplication(app.id);
    assert.ok(
      Date.parse(afterAdd.updatedAt) > Date.parse(app.updatedAt),
      `updatedAt was not bumped by addProcess: ${app.updatedAt} -> ${afterAdd.updatedAt}`
    );

    await afterTheClockTicksPast(afterAdd.updatedAt);
    await apps.removeProcess(app.id, proc.id);
    const afterRemove = await apps.getApplication(app.id);
    assert.ok(
      Date.parse(afterRemove.updatedAt) > Date.parse(afterAdd.updatedAt),
      `updatedAt was not bumped by removeProcess: ${afterAdd.updatedAt} -> ${afterRemove.updatedAt}`
    );
    assert.equal(afterRemove.createdAt, app.createdAt);
  });

  test('a repositoryPath change is rejected when it no longer contains the stored workingDirectory', async () => {
    const app = await createApp('recheck');
    const proc = await apps.addProcess(app.id, processInput({ workingDirectory: subDir }));
    assert.equal(proc.workingDirectory, subDir);
    await rejectsWith(
      apps.updateProcess(app.id, proc.id, { repositoryPath: outsideDir }),
      apps.ValidationError,
      subDir,
      outsideDir
    );
  });
});

describe('name validation', () => {
  test('an empty application name is rejected', async () => {
    await rejectsWith(
      apps.createApplication({ name: '' }),
      apps.ValidationError,
      'application name must be a non-empty string'
    );
  });

  test('a whitespace-only application name is rejected', async () => {
    await rejectsWith(
      apps.createApplication({ name: '   \t  ' }),
      apps.ValidationError,
      'application name must be a non-empty string'
    );
  });

  test('a missing or non-string application name is rejected and the message names the value', async () => {
    await rejectsWith(apps.createApplication({}), apps.ValidationError, 'undefined');
    await rejectsWith(apps.createApplication({ name: 42 }), apps.ValidationError, '42');
    await rejectsWith(apps.createApplication({ name: ['a'] }), apps.ValidationError, 'an array');
  });

  test('a non-object application input is rejected as a ValidationError, not a TypeError', async () => {
    await rejectsWith(
      apps.createApplication('just a name'),
      apps.ValidationError,
      'application input must be an object'
    );
  });

  test('a name of exactly 80 characters is accepted and 81 is rejected', async () => {
    const app = await apps.createApplication({ name: 'a'.repeat(80) });
    assert.equal(app.name.length, 80);
    await rejectsWith(
      apps.createApplication({ name: 'b'.repeat(81) }),
      apps.ValidationError,
      'at most 80 characters',
      'received 81'
    );
  });

  test('length is measured after trimming, so padding does not push a legal name over the limit', async () => {
    const app = await apps.createApplication({ name: `   ${'c'.repeat(80)}   ` });
    assert.equal(app.name.length, 80);
  });

  test('application names are unique globally and compared case-insensitively', async () => {
    const name = unique('Checkout');
    const first = await apps.createApplication({ name });
    await rejectsWith(
      apps.createApplication({ name: name.toUpperCase() }),
      apps.ValidationError,
      first.id,
      'case-insensitively'
    );
  });

  test('process names are unique within their application, case-insensitively', async () => {
    const app = await createApp('scope');
    const name = unique('Worker');
    const first = await apps.addProcess(app.id, processInput({ name }));
    await rejectsWith(
      apps.addProcess(app.id, processInput({ name: name.toLowerCase() })),
      apps.ValidationError,
      first.id
    );
  });

  test('the same process name is free to reuse in a different application', async () => {
    const one = await createApp('scope');
    const two = await createApp('scope');
    const name = unique('api');
    await apps.addProcess(one.id, processInput({ name }));
    const twin = await apps.addProcess(two.id, processInput({ name }));
    assert.equal(twin.name, name);
  });

  test('renaming an application to its own current name is allowed', async () => {
    const app = await createApp('self');
    const updated = await apps.updateApplication(app.id, { name: app.name });
    assert.equal(updated.name, app.name);
  });

  test('renaming an application onto another application name is rejected', async () => {
    const mine = await createApp('mine');
    const theirs = await createApp('theirs');
    await rejectsWith(
      apps.updateApplication(mine.id, { name: theirs.name.toUpperCase() }),
      apps.ValidationError,
      theirs.id
    );
    assert.equal((await apps.getApplication(mine.id)).name, mine.name);
  });

  test('renaming a process to its own current name is allowed', async () => {
    const app = await createApp('selfproc');
    const proc = await apps.addProcess(app.id, processInput());
    const updated = await apps.updateProcess(app.id, proc.id, { name: proc.name });
    assert.equal(updated.name, proc.name);
  });

  test('renaming a process onto a sibling process name is rejected', async () => {
    const app = await createApp('siblings');
    const first = await apps.addProcess(app.id, processInput());
    const second = await apps.addProcess(app.id, processInput());
    await rejectsWith(
      apps.updateProcess(app.id, second.id, { name: first.name.toUpperCase() }),
      apps.ValidationError,
      first.id
    );
    assert.equal((await apps.getApplication(app.id)).processes[1].name, second.name);
  });

  test('two concurrent creates of the same name cannot both win', async () => {
    const name = unique('race');
    const results = await Promise.allSettled([
      apps.createApplication({ name }),
      apps.createApplication({ name }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'the name-uniqueness check was split from the write it guards');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof apps.ValidationError);
    const matches = (await apps.listApplications()).filter((a) => a.name === name);
    assert.equal(matches.length, 1);
  });
});

describe('repositoryPath validation', () => {
  test('a relative repositoryPath is rejected and the message quotes the value', async () => {
    const app = await createApp('relpath');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ repositoryPath: './repo' })),
      apps.ValidationError,
      'repositoryPath must be an absolute path',
      "'./repo'"
    );
  });

  test('a non-existent repositoryPath is rejected and the message quotes the path', async () => {
    const app = await createApp('nopath');
    const missing = path.join(tmpRoot, 'no-such-repo');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ repositoryPath: missing })),
      apps.ValidationError,
      missing,
      'does not exist'
    );
  });

  test('a repositoryPath that is a file, not a directory, is rejected', async () => {
    const app = await createApp('filepath');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ repositoryPath: regularFile })),
      apps.ValidationError,
      regularFile,
      'is not a directory'
    );
  });

  test('a missing or empty repositoryPath is rejected', async () => {
    const app = await createApp('emptypath');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ repositoryPath: undefined })),
      apps.ValidationError,
      'repositoryPath must be a non-empty string'
    );
    await rejectsWith(
      apps.addProcess(app.id, processInput({ repositoryPath: '   ' })),
      apps.ValidationError,
      'repositoryPath must be a non-empty string'
    );
  });

  test('a trailing slash is normalised away before the path is stored', async () => {
    const app = await createApp('slash');
    const proc = await apps.addProcess(app.id, processInput({ repositoryPath: `${repo}/` }));
    assert.equal(proc.repositoryPath, repo);
  });

  test('a .. segment is collapsed before the path is stored', async () => {
    const app = await createApp('dotdot');
    const proc = await apps.addProcess(
      app.id,
      processInput({ repositoryPath: path.join(repo, 'packages', '..') })
    );
    assert.equal(proc.repositoryPath, repo);
  });
});

describe('workingDirectory containment', () => {
  test('an omitted workingDirectory is stored as null, meaning "use repositoryPath"', async () => {
    const app = await createApp('wdnull');
    const proc = await apps.addProcess(app.id, processInput());
    assert.equal(proc.workingDirectory, null);
    const emptyString = await apps.addProcess(app.id, processInput({ workingDirectory: '' }));
    assert.equal(emptyString.workingDirectory, null);
  });

  test('a workingDirectory equal to the repository path is accepted', async () => {
    const app = await createApp('wdroot');
    const proc = await apps.addProcess(app.id, processInput({ workingDirectory: repo }));
    assert.equal(proc.workingDirectory, repo);
  });

  test('a workingDirectory in a genuine subdirectory is accepted', async () => {
    const app = await createApp('wdsub');
    const proc = await apps.addProcess(app.id, processInput({ workingDirectory: subDir }));
    assert.equal(proc.workingDirectory, subDir);
  });

  test('a workingDirectory outside the repository is rejected, naming both paths', async () => {
    const app = await createApp('wdout');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: outsideDir })),
      apps.ValidationError,
      outsideDir,
      repo,
      'must be inside repositoryPath'
    );
  });

  test('a sibling directory sharing the repository prefix is rejected (repo vs repo-evil)', async () => {
    const app = await createApp('wdprefix');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: siblingPrefixDir })),
      apps.ValidationError,
      siblingPrefixDir,
      'must be inside repositoryPath'
    );
  });

  test('a workingDirectory reaching out with .. is rejected once the path is resolved', async () => {
    const app = await createApp('wddotdot');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: path.join(repo, '..', 'elsewhere') })),
      apps.ValidationError,
      outsideDir,
      'must be inside repositoryPath'
    );
  });

  test('a relative workingDirectory is rejected', async () => {
    const app = await createApp('wdrel');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: 'packages/api' })),
      apps.ValidationError,
      'workingDirectory must be an absolute path',
      "'packages/api'"
    );
  });

  test('a non-existent workingDirectory inside the repository is rejected', async () => {
    const app = await createApp('wdmissing');
    const missing = path.join(repo, 'packages', 'ghost');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: missing })),
      apps.ValidationError,
      missing,
      'does not exist'
    );
  });

  test('a workingDirectory that is a file inside the repository is rejected', async () => {
    const app = await createApp('wdfile');
    const inRepoFile = path.join(repo, 'README.md');
    await fs.writeFile(inRepoFile, '# repo\n');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: inRepoFile })),
      apps.ValidationError,
      inRepoFile,
      'is not a directory'
    );
  });

  test('a symlink inside the repository pointing out of it is rejected', async () => {
    const app = await createApp('wdlink');
    const link = path.join(repo, 'escape-hatch');
    await fs.symlink(outsideDir, link, 'dir');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ workingDirectory: link })),
      apps.ValidationError,
      link,
      outsideDir
    );
  });
});

describe('env validation', () => {
  test('a key that starts with a digit is rejected and the message quotes it', async () => {
    const app = await createApp('envkey');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ env: { '1PORT': '3000' } })),
      apps.ValidationError,
      "'1PORT'",
      'not a valid environment variable name'
    );
  });

  test('a key containing a dash, a dot or a space is rejected', async () => {
    const app = await createApp('envkey');
    for (const key of ['HAS-DASH', 'has.dot', 'HAS SPACE', '']) {
      await rejectsWith(
        apps.addProcess(app.id, processInput({ env: { [key]: 'x' } })),
        apps.ValidationError,
        'not a valid environment variable name'
      );
    }
  });

  test('numbers and booleans are coerced to strings', async () => {
    const app = await createApp('envcoerce');
    const proc = await apps.addProcess(
      app.id,
      processInput({ env: { PORT: 3000, DEBUG: true, RATIO: 0.5 } })
    );
    assert.deepEqual(proc.env, { PORT: '3000', DEBUG: 'true', RATIO: '0.5' });
  });

  test('an object or null env value is rejected, naming the key', async () => {
    const app = await createApp('envvalue');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ env: { NESTED: { a: 1 } } })),
      apps.ValidationError,
      "env value for 'NESTED'",
      'an object'
    );
    await rejectsWith(
      apps.addProcess(app.id, processInput({ env: { EMPTY: null } })),
      apps.ValidationError,
      "env value for 'EMPTY'"
    );
  });

  test('a non-object env is rejected', async () => {
    const app = await createApp('envshape');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ env: 'PORT=3000' })),
      apps.ValidationError,
      'env must be an object'
    );
  });

  test('emptying PATH is rejected but overriding it with a value is allowed', async () => {
    const app = await createApp('envpath');
    await rejectsWith(
      apps.addProcess(app.id, processInput({ env: { PATH: '   ' } })),
      apps.ValidationError,
      "env value for 'PATH' must not be empty"
    );
    const proc = await apps.addProcess(app.id, processInput({ env: { PATH: '/usr/bin' } }));
    assert.equal(proc.env.PATH, '/usr/bin');
  });

  test('an env variable literally named __proto__ round-trips as an own property', async () => {
    const app = await createApp('envproto');
    // Built the way a JSON request body builds it: an object literal would set the prototype instead.
    const env = JSON.parse('{"__proto__": "kept", "NORMAL": "also kept"}');
    const proc = await apps.addProcess(app.id, processInput({ env }));

    assert.deepEqual(Object.getOwnPropertyNames(proc.env).sort(), ['NORMAL', '__proto__']);
    assert.equal(Object.getOwnPropertyDescriptor(proc.env, '__proto__').value, 'kept');
    assert.equal(Object.getPrototypeOf(proc.env), Object.prototype);
    assert.equal({}.NORMAL, undefined, 'Object.prototype was polluted');

    const reread = (await apps.getApplication(app.id)).processes.find((p) => p.id === proc.id);
    assert.equal(Object.getOwnPropertyDescriptor(reread.env, '__proto__').value, 'kept');
  });

  test('an env variable named __proto__ survives a write and a fresh read from disk', async () => {
    const app = await createApp('envprotodisk');
    const env = JSON.parse('{"__proto__": "from-disk"}');
    const proc = await apps.addProcess(app.id, processInput({ env }));

    // A fresh process is the only way to bypass json-db's in-memory cache and prove the JSON
    // written to disk still carries the key.
    const script = `
      const apps = await import(${JSON.stringify(APPLICATIONS_URL)});
      const app = await apps.getApplication(${JSON.stringify(app.id)});
      const { env } = app.processes.find((p) => p.id === ${JSON.stringify(proc.id)});
      process.stdout.write(JSON.stringify({
        keys: Object.getOwnPropertyNames(env),
        value: Object.getOwnPropertyDescriptor(env, '__proto__')?.value ?? null,
      }));
    `;
    // `timeout` so a child that somehow wedges is SIGKILLed rather than outliving the suite: the test
    // runner's own timeout is off by default, and an orphaned node holding the fixture directory open
    // would survive the `after` hook that removes it.
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PADDOCK_DATA_DIR: dataDir },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    assert.deepEqual(JSON.parse(stdout), { keys: ['__proto__'], value: 'from-disk' });
  });
});

describe('NotFoundError', () => {
  const MISSING_APP = 'app_000000000000';
  const MISSING_PROC = 'proc_000000000000';

  test('every application-scoped call throws NotFoundError for an unknown application id', async () => {
    await rejectsWith(apps.getApplication(MISSING_APP), apps.NotFoundError, MISSING_APP);
    await rejectsWith(
      apps.updateApplication(MISSING_APP, { name: unique('ghost') }),
      apps.NotFoundError,
      MISSING_APP
    );
    await rejectsWith(apps.deleteApplication(MISSING_APP), apps.NotFoundError, MISSING_APP);
    await rejectsWith(
      apps.addProcess(MISSING_APP, processInput()),
      apps.NotFoundError,
      MISSING_APP
    );
    await rejectsWith(
      apps.updateProcess(MISSING_APP, MISSING_PROC, { command: 'x' }),
      apps.NotFoundError,
      MISSING_APP
    );
    await rejectsWith(apps.removeProcess(MISSING_APP, MISSING_PROC), apps.NotFoundError, MISSING_APP);
  });

  test('an unknown process id throws NotFoundError naming the process and its application', async () => {
    const app = await createApp('notfound');
    await rejectsWith(
      apps.updateProcess(app.id, MISSING_PROC, { command: 'x' }),
      apps.NotFoundError,
      MISSING_PROC,
      app.id
    );
    await rejectsWith(
      apps.removeProcess(app.id, MISSING_PROC),
      apps.NotFoundError,
      MISSING_PROC,
      app.id
    );
  });

  test('a process id belonging to another application is not found in this one', async () => {
    const owner = await createApp('owner');
    const other = await createApp('other');
    const proc = await apps.addProcess(owner.id, processInput());
    await rejectsWith(apps.removeProcess(other.id, proc.id), apps.NotFoundError, proc.id);
    assert.equal((await apps.getApplication(owner.id)).processes.length, 1);
  });

  test('NotFoundError is distinct from ValidationError so the HTTP layer can map 404 vs 400', async () => {
    await assert.rejects(apps.getApplication(MISSING_APP), (err) => {
      assert.equal(err.name, 'NotFoundError');
      assert.equal(err.code, 'NOT_FOUND');
      assert.ok(!(err instanceof apps.ValidationError));
      return true;
    });
    await assert.rejects(apps.createApplication({ name: '' }), (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.ok(!(err instanceof apps.NotFoundError));
      return true;
    });
  });
});

describe('PostgreSQL applications', () => {
  /** Directory fixtures only: validation checks what initdb leaves on disk, not a running server. */
  let clusterDir;
  let otherClusterDir;
  let binDir;

  before(async () => {
    clusterDir = path.join(tmpRoot, 'pgdata');
    otherClusterDir = path.join(tmpRoot, 'pgdata-other');
    binDir = path.join(tmpRoot, 'pgbin');
    for (const dir of [clusterDir, otherClusterDir, binDir]) await fs.mkdir(dir);
    await fs.writeFile(path.join(clusterDir, 'PG_VERSION'), '16\n');
    await fs.writeFile(path.join(otherClusterDir, 'PG_VERSION'), '16\n');
    await fs.writeFile(path.join(binDir, 'pg_ctl'), '#!/bin/sh\n', { mode: 0o755 });
  });

  /** Each test gets a cluster no other application claims, so data-directory uniqueness never bites. */
  const freshCluster = async () => {
    const dir = path.join(tmpRoot, unique('cluster'));
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'PG_VERSION'), '16\n');
    return dir;
  };

  const createPostgres = async (postgres, hint = 'pg') =>
    apps.createApplication({ name: unique(hint), kind: 'postgres', postgres });

  test('an application created without a kind is a group of processes with no postgres settings', async () => {
    const app = await createApp('kindless');
    assert.equal(app.kind, 'processes');
    assert.equal(app.postgres, null);
  });

  test('a PostgreSQL application fills in every default and stores no processes', async () => {
    const app = await createPostgres({ dataDirectory: await freshCluster() });
    assert.equal(app.kind, 'postgres');
    assert.deepEqual(
      { ...app.postgres, dataDirectory: undefined },
      {
        dataDirectory: undefined,
        port: 5432,
        binDirectory: null,
        user: os.userInfo().username,
        password: '',
        maintenanceDatabase: 'postgres',
        logFile: null,
      }
    );
    assert.deepEqual(app.processes, []);
  });

  test('blank user and maintenance database mean the defaults, the way an untouched form sends them', async () => {
    const app = await createPostgres({ dataDirectory: await freshCluster(), user: '  ', maintenanceDatabase: '' });
    assert.equal(app.postgres.user, os.userInfo().username);
    assert.equal(app.postgres.maintenanceDatabase, 'postgres');
  });

  test('an unknown kind is rejected, naming the kinds there are', async () => {
    await rejectsWith(
      apps.createApplication({ name: unique('bad-kind'), kind: 'mysql' }),
      apps.ValidationError,
      "'processes' or 'postgres'",
      "'mysql'"
    );
  });

  test('a directory with no PG_VERSION is refused, pointing at initdb', async () => {
    await rejectsWith(createPostgres({ dataDirectory: outsideDir }), apps.ValidationError, 'PG_VERSION', 'initdb');
  });

  test('a missing data directory is refused rather than stored', async () => {
    await rejectsWith(createPostgres({}), apps.ValidationError, 'dataDirectory');
  });

  test('an application may be named first and have its server defined afterwards', async () => {
    const app = await apps.createApplication({ name: unique('pg-later'), kind: 'postgres' });
    assert.equal(app.postgres, null);
    assert.deepEqual(app.processes, []);

    // The first settings define the server, so they need what a create needs.
    await rejectsWith(apps.updateApplication(app.id, { postgres: { port: 5433 } }), apps.ValidationError, 'dataDirectory');
    const renamed = await apps.updateApplication(app.id, { name: unique('pg-later') });
    assert.equal(renamed.postgres, null);

    const defined = await apps.updateApplication(app.id, { postgres: { dataDirectory: await freshCluster(), port: 5433 } });
    assert.equal(defined.postgres.port, 5433);
    assert.equal(defined.postgres.user, os.userInfo().username);
    assert.equal(defined.postgres.maintenanceDatabase, 'postgres');
  });

  test('a port must be an integer in range — a string that looks like one is a form bug', async () => {
    const dataDirectory = await freshCluster();
    await rejectsWith(createPostgres({ dataDirectory, port: '5432' }), apps.ValidationError, 'port');
    await rejectsWith(createPostgres({ dataDirectory, port: 70_000 }), apps.ValidationError, 'port');
  });

  test('a bin directory without pg_ctl is refused; one with it is kept', async () => {
    const dataDirectory = await freshCluster();
    await rejectsWith(
      createPostgres({ dataDirectory, binDirectory: outsideDir }),
      apps.ValidationError,
      'pg_ctl executable'
    );
    const app = await createPostgres({ dataDirectory, binDirectory: binDir });
    assert.equal(app.postgres.binDirectory, binDir);
  });

  test('a log file must be absolute and in a directory that exists — pg_ctl will not create one', async () => {
    const dataDirectory = await freshCluster();
    await rejectsWith(createPostgres({ dataDirectory, logFile: 'pg.log' }), apps.ValidationError, 'logFile');
    await rejectsWith(
      createPostgres({ dataDirectory, logFile: path.join(tmpRoot, 'no-such-dir', 'pg.log') }),
      apps.ValidationError,
      'logFile directory'
    );
    const app = await createPostgres({ dataDirectory, logFile: path.join(tmpRoot, 'pg.log') });
    assert.equal(app.postgres.logFile, path.join(tmpRoot, 'pg.log'));
  });

  test('postgres settings on a processes application are refused on create and on update', async () => {
    await rejectsWith(
      apps.createApplication({ name: unique('mixed'), postgres: { dataDirectory: clusterDir } }),
      apps.ValidationError,
      "kind 'postgres'"
    );
    const app = await createApp('mixed');
    await rejectsWith(
      apps.updateApplication(app.id, { postgres: { port: 5433 } }),
      apps.ValidationError,
      "kind 'postgres'"
    );
  });

  test('the kind cannot be changed by an update', async () => {
    const app = await createApp('fixed-kind');
    await rejectsWith(
      apps.updateApplication(app.id, { kind: 'postgres' }),
      apps.ValidationError,
      'kind cannot be changed'
    );
  });

  test('an update touches only the settings it sends — leaving the password out keeps it', async () => {
    const app = await createPostgres({ dataDirectory: await freshCluster(), password: 'secret' });
    const moved = await apps.updateApplication(app.id, { postgres: { port: 5555 } });
    assert.equal(moved.postgres.port, 5555);
    assert.equal(moved.postgres.password, 'secret');

    const cleared = await apps.updateApplication(app.id, { postgres: { password: '' } });
    assert.equal(cleared.postgres.password, '');
    assert.equal(cleared.postgres.port, 5555);
  });

  test('two applications cannot claim one data directory, but an application may keep its own', async () => {
    const first = await createPostgres({ dataDirectory: otherClusterDir });
    await rejectsWith(
      createPostgres({ dataDirectory: otherClusterDir }),
      apps.ValidationError,
      otherClusterDir,
      first.id
    );
    const kept = await apps.updateApplication(first.id, { postgres: { dataDirectory: otherClusterDir } });
    assert.equal(kept.postgres.dataDirectory, otherClusterDir);
  });

  test('its process list cannot be edited: add, update and remove are all refused', async () => {
    const app = await createPostgres({ dataDirectory: await freshCluster() });
    await rejectsWith(apps.addProcess(app.id, processInput()), apps.ValidationError, 'PostgreSQL application');
    await rejectsWith(
      apps.updateProcess(app.id, 'postgres', { command: 'x' }),
      apps.ValidationError,
      'PostgreSQL application'
    );
    await rejectsWith(apps.removeProcess(app.id, 'postgres'), apps.ValidationError, 'PostgreSQL application');
  });
});

// The data directory belongs to this run alone; leaving it behind accumulates one
// directory per run in the system temp folder.
after(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});
