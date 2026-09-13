/**
 * Regression suite for workspace.js — what the process form is allowed to read off the user's disk.
 * Everything goes through the public exports and every fixture is a real directory with real files:
 * the module's whole job is to report what is actually there, so a stubbed filesystem would be
 * testing the stub.
 *
 * The data directory is still redirected before the first dynamic import — workspace.js imports
 * applications.js, which pulls in config.js, which resolves DATA_DIR at import time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_URL = pathToFileURL(path.join(PROJECT_ROOT, 'workspace.js')).href;

/** @type {typeof import('../workspace.js')} */
let workspace;

let tmpRoot;
let repo;
let emptyDir;
let regularFile;

const write = (file, content) => fs.writeFile(file, content);

const envOf = (inspection, name) => inspection.envFiles.find((file) => file.name === name);

/** The variables of one .env as a plain object, which is what every assertion below is about. */
const valuesOf = (file) => Object.fromEntries(file.variables.map((v) => [v.key, v.value]));

const rejectsWith = (promise, ...fragments) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.name, 'ValidationError', `expected ValidationError, got ${err?.name}`);
    for (const fragment of fragments) {
      assert.ok(
        err.message.includes(fragment),
        `expected message to mention ${JSON.stringify(fragment)}, got: ${err.message}`
      );
    }
    return true;
  });

before(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-workspace-')));
  process.env.PADDOCK_DATA_DIR = path.join(tmpRoot, 'data');

  repo = path.join(tmpRoot, 'repo');
  emptyDir = path.join(repo, 'empty');
  regularFile = path.join(repo, 'README.md');
  await fs.mkdir(path.join(repo, 'packages', 'api'), { recursive: true });
  await fs.mkdir(emptyDir, { recursive: true });
  await write(regularFile, '# fixture');

  workspace = await import(WORKSPACE_URL);
});

after(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('listDirectory', () => {
  test('returns the subdirectories and the parent, and never the files', async () => {
    const listing = await workspace.listDirectory(repo);
    assert.equal(listing.path, repo);
    assert.equal(listing.parent, tmpRoot);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['empty', 'packages']
    );
    assert.equal(listing.truncated, false);
  });

  test('every entry carries the full path, so the picker never joins one itself', async () => {
    const listing = await workspace.listDirectory(repo);
    const entry = listing.entries.find((candidate) => candidate.name === 'packages');
    assert.equal(entry.path, path.join(repo, 'packages'));
  });

  test('an unset path opens at the home directory', async () => {
    for (const unset of [undefined, null, '', '   ']) {
      assert.equal((await workspace.listDirectory(unset)).path, os.homedir());
    }
  });

  test('the filesystem root reports no parent', async () => {
    const listing = await workspace.listDirectory(path.parse(tmpRoot).root);
    assert.equal(listing.parent, null);
  });

  test('a symlink to a directory is offered; a broken one is not', async () => {
    const linked = path.join(tmpRoot, 'links');
    await fs.mkdir(linked);
    await fs.symlink(path.join(repo, 'packages'), path.join(linked, 'to-packages'));
    await fs.symlink(path.join(repo, 'nothing-here'), path.join(linked, 'dangling'));
    await fs.symlink(regularFile, path.join(linked, 'to-a-file'));

    const listing = await workspace.listDirectory(linked);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['to-packages']
    );
  });

  test('a relative path, a file and a missing directory are all rejected by name', async () => {
    await rejectsWith(workspace.listDirectory('relative/path'), 'absolute');
    await rejectsWith(workspace.listDirectory(regularFile), 'is not a directory');
    await rejectsWith(workspace.listDirectory(path.join(repo, 'nope')), 'does not exist');
  });
});

describe('inspect: package.json', () => {
  before(async () => {
    await write(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: '@acme/root',
        scripts: { build: 'tsc', start: 'node .', dev: 'vite', install: 'echo hi', broken: 7 },
      })
    );
    await write(path.join(repo, 'package-lock.json'), '{}');
  });

  test('suggests every script, dev and start first and the rest in declaration order', async () => {
    const { scripts } = await workspace.inspect(repo);
    assert.deepEqual(
      scripts.map((script) => script.name),
      ['dev', 'start', 'build', 'install']
    );
  });

  test('a script whose body is not a string is not a script', async () => {
    const { scripts } = await workspace.inspect(repo);
    assert.equal(
      scripts.find((script) => script.name === 'broken'),
      undefined
    );
  });

  test('carries the body as well as the command, so the form can show what it will run', async () => {
    const { scripts, packageName } = await workspace.inspect(repo);
    assert.equal(packageName, '@acme/root');
    assert.deepEqual(scripts[0], { name: 'dev', script: 'vite', command: 'npm run dev' });
  });

  test('always the long form, so a script named after a subcommand still runs', async () => {
    const { scripts } = await workspace.inspect(repo);
    assert.equal(scripts.find((script) => script.name === 'install').command, 'npm run install');
  });

  test('the lockfile names the package manager', async () => {
    const api = path.join(repo, 'packages', 'api');
    await write(path.join(api, 'package.json'), JSON.stringify({ scripts: { dev: 'nodemon' } }));
    await write(path.join(api, 'yarn.lock'), '');

    const inspection = await workspace.inspect(api);
    assert.equal(inspection.packageManager, 'yarn');
    assert.equal(inspection.scripts[0].command, 'yarn run dev');
  });

  test('a declared packageManager outranks the lockfile lying next to it', async () => {
    const declared = path.join(tmpRoot, 'declared');
    await fs.mkdir(declared);
    await write(path.join(declared, 'package-lock.json'), '{}');
    await write(
      path.join(declared, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { dev: 'vite' } })
    );

    const inspection = await workspace.inspect(declared);
    assert.equal(inspection.packageManager, 'pnpm');
    assert.equal(inspection.scripts[0].command, 'pnpm run dev');
  });

  test('a directory with no package.json suggests nothing rather than failing', async () => {
    const inspection = await workspace.inspect(emptyDir);
    assert.deepEqual(inspection.scripts, []);
    assert.equal(inspection.packageManager, null);
    assert.equal(inspection.packageName, null);
  });

  test('a package.json that will not parse also suggests nothing rather than failing', async () => {
    const broken = path.join(tmpRoot, 'broken-package');
    await fs.mkdir(broken);
    await write(path.join(broken, 'package.json'), '{ not json');

    const inspection = await workspace.inspect(broken);
    assert.deepEqual(inspection.scripts, []);
    assert.equal(inspection.packageManager, null);
  });
});

describe('inspect: .env files', () => {
  let envDir;

  before(async () => {
    envDir = path.join(tmpRoot, 'env');
    await fs.mkdir(envDir);
    await write(
      path.join(envDir, '.env'),
      [
        '# a comment line',
        '',
        'PLAIN=hello',
        'export EXPORTED=yes',
        'SPACED  =  spaced out  ',
        'QUOTED="a b # not a comment"',
        "SINGLE='raw \\n stays'",
        'ESCAPED="line1\\nline2\\ttabbed"',
        'MULTI="first',
        'second"',
        'EMPTY=',
        'AFTER_EMPTY=still read',
        'TRAILING=value   # trailing comment',
        'foo.bar=not a variable name',
        '1BAD=nor is this',
        'PLAIN=overridden',
      ].join('\n')
    );
    await write(path.join(envDir, '.env.example'), 'API_KEY=\nDATABASE_URL=postgres://x');
    await write(path.join(envDir, '.env.local'), 'LOCAL=1');
    await write(path.join(envDir, 'env.txt'), 'NOT_AN_ENV_FILE=1');
  });

  test('.env comes first and the variants follow it alphabetically', async () => {
    const { envFiles } = await workspace.inspect(envDir);
    assert.deepEqual(
      envFiles.map((file) => file.name),
      ['.env', '.env.example', '.env.local']
    );
  });

  test('reads plain, exported, quoted, escaped and multiline values', async () => {
    const values = valuesOf(envOf(await workspace.inspect(envDir), '.env'));
    assert.equal(values.PLAIN, 'overridden', 'the last assignment of a key wins');
    assert.equal(values.EXPORTED, 'yes');
    assert.equal(values.SPACED, 'spaced out');
    assert.equal(values.QUOTED, 'a b # not a comment');
    assert.equal(values.SINGLE, 'raw \\n stays', 'single quotes expand nothing');
    assert.equal(values.ESCAPED, 'line1\nline2\ttabbed');
    assert.equal(values.MULTI, 'first\nsecond');
    assert.equal(values.TRAILING, 'value');
  });

  // The bug this guards: with a gap that may cross a line break, `EMPTY=` reads the *next* line as
  // its value and swallows the assignment on it. An empty assignment is the commonest line there is.
  test('an empty assignment is empty, and does not consume the line below it', async () => {
    const values = valuesOf(envOf(await workspace.inspect(envDir), '.env'));
    assert.equal(values.EMPTY, '');
    assert.equal(values.AFTER_EMPTY, 'still read');

    const example = valuesOf(envOf(await workspace.inspect(envDir), '.env.example'));
    assert.deepEqual(example, { API_KEY: '', DATABASE_URL: 'postgres://x' });
  });

  test('names this manager would refuse are reported rather than dropped in silence', async () => {
    const file = envOf(await workspace.inspect(envDir), '.env');
    assert.deepEqual(file.skipped, ['foo.bar', '1BAD']);
    assert.equal(
      file.variables.find((variable) => variable.key === 'foo.bar'),
      undefined
    );
  });

  test('a file that is not a .env is not read', async () => {
    const { envFiles } = await workspace.inspect(envDir);
    assert.equal(
      envFiles.find((file) => file.name === 'env.txt'),
      undefined
    );
  });

  test('a .env that cannot be read says why instead of looking empty', async () => {
    const weird = path.join(tmpRoot, 'weird-env');
    await fs.mkdir(path.join(weird, '.env'), { recursive: true }); // a directory named .env
    const file = envOf(await workspace.inspect(weird), '.env');
    assert.match(file.error, /is not a file/);
    assert.deepEqual(file.variables, []);
  });

  test('a directory with no .env at all reports none', async () => {
    assert.deepEqual((await workspace.inspect(emptyDir)).envFiles, []);
  });
});

describe('inspect: the path itself', () => {
  test('is rejected exactly as the save that follows it would reject it', async () => {
    await rejectsWith(workspace.inspect(''), 'non-empty string');
    await rejectsWith(workspace.inspect('relative/path'), 'absolute');
    await rejectsWith(workspace.inspect(regularFile), 'is not a directory');
    await rejectsWith(workspace.inspect(path.join(repo, 'nope')), 'does not exist');
  });

  test("comes back resolved, and as the path asked for rather than a symlink's target", async () => {
    const alias = path.join(tmpRoot, 'alias');
    await fs.symlink(repo, alias);
    // '..' and a trailing separator are collapsed, and the symlink is left alone: browsing through
    // a link must not silently relocate the user to the directory it points at.
    assert.equal((await workspace.inspect(`${alias}/packages/..`)).path, alias);
    assert.equal((await workspace.listDirectory(`${alias}/`)).path, alias);
  });
});
