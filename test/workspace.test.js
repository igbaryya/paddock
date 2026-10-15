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

describe('inspect: stacks', () => {
  /** @type {typeof import('../platform/index.js')} */
  let platform;

  /** A directory holding exactly `files` (relative path → content), parents created as needed. */
  const fixture = async (name, files) => {
    const dir = path.join(tmpRoot, 'stacks', name);
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await write(path.join(dir, relative), content);
    }
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const stacksOf = async (dir) => (await workspace.inspect(dir)).stacks;
  const stackOf = async (dir, id) => (await stacksOf(dir)).find((stack) => stack.id === id);
  const commandsOf = (stack) => stack.suggestions.map((suggestion) => suggestion.command);

  before(async () => {
    platform = await import(pathToFileURL(path.join(PROJECT_ROOT, 'platform', 'index.js')).href);
  });

  test('a directory with nothing in it is no stack at all', async () => {
    assert.deepEqual(await stacksOf(emptyDir), []);
  });

  test('FastAPI under uv: uvicorn through uv, pointed at the app object it found', async () => {
    const dir = await fixture('fastapi-uv', {
      'pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi[standard]>=0.110"]\n',
      'uv.lock': '',
      'main.py': 'from fastapi import FastAPI\n\napi: FastAPI = FastAPI(title="x")\n',
    });
    const python = await stackOf(dir, 'python');
    assert.deepEqual(python.details, ['uv', 'FastAPI']);
    assert.deepEqual(python.evidence, ['pyproject.toml', 'uv.lock']);
    assert.deepEqual(commandsOf(python), ['uv run python -m uvicorn main:api --reload']);
    assert.deepEqual(python.notes, []);
  });

  test('a src layout tells uvicorn where to import from', async () => {
    const dir = await fixture('fastapi-src', {
      'requirements.txt': 'fastapi\nuvicorn\n',
      'src/main.py': 'app = FastAPI()\n',
    });
    const [first] = commandsOf(await stackOf(dir, 'python'));
    assert.equal(first, `${platform.pythonCommand} -m uvicorn main:app --reload --app-dir src`);
  });

  test('a src that is a package is imported as one, from the project', async () => {
    const dir = await fixture('fastapi-src-package', {
      'requirements.txt': 'fastapi\n',
      'src/__init__.py': '',
      'src/main.py': 'from .utils import x\nfrom fastapi import FastAPI\n\napp = FastAPI()\n',
    });
    const [first] = commandsOf(await stackOf(dir, 'python'));
    assert.equal(first, `${platform.pythonCommand} -m uvicorn src.main:app --reload`);
  });

  test('an entry file longer than a manifest is still searched for its app object', async () => {
    const routes = '@app.get("/x")\ndef x():\n    return 1\n'.repeat(12_000);
    const dir = await fixture('fastapi-long-main', {
      'requirements.txt': 'fastapi\n',
      'main.py': `from fastapi import FastAPI\n\napp = FastAPI()\n\n${routes}`,
    });
    const [first] = commandsOf(await stackOf(dir, 'python'));
    assert.equal(first, `${platform.pythonCommand} -m uvicorn main:app --reload`);
  });

  test('the port the Dockerfile serves the app on is the port it runs on here', async () => {
    const dir = await fixture('fastapi-dockerfile-port', {
      'requirements.txt': 'fastapi\n',
      'main.py': 'app = FastAPI()\n',
      Dockerfile: 'FROM python:3.12\nEXPOSE 8001\nCMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]\n',
    });
    const [first] = commandsOf(await stackOf(dir, 'python'));
    assert.equal(first, `${platform.pythonCommand} -m uvicorn main:app --reload --port 8001`);
  });

  test("Django runs manage.py with the project's own virtual environment", async () => {
    const venvPython = platform.venvPython('.venv');
    const dir = await fixture('django-venv', {
      'manage.py': '#!/usr/bin/env python\n',
      'requirements.txt': 'Django==5.0\n',
      [venvPython]: '',
    });
    const python = await stackOf(dir, 'python');
    assert.deepEqual(python.details, ['.venv', 'Django']);
    assert.equal(commandsOf(python)[0], `${venvPython} manage.py runserver`);
  });

  test('Flask with no environment uses the PATH interpreter, and says so', async () => {
    const dir = await fixture('flask-bare', {
      'requirements.txt': 'flask>=3\n',
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
      'run.py': 'print(1)\n',
    });
    const python = await stackOf(dir, 'python');
    assert.deepEqual(commandsOf(python), [
      `${platform.pythonCommand} -m flask --app app.py run --debug`,
      `${platform.pythonCommand} run.py`,
    ]);
    assert.equal(python.notes.length, 1);
    assert.match(python.notes[0], /No virtual environment/);
  });

  test('a dependency named like another is not mistaken for it', async () => {
    const dir = await fixture('python-lookalike', { 'requirements.txt': 'django-environ\nmy-flask-thing\n' });
    assert.deepEqual((await stackOf(dir, 'python')).details, []);
  });

  test('pyproject console scripts are offered through the project tool', async () => {
    const dir = await fixture('poetry-scripts', {
      'pyproject.toml': '[tool.poetry]\nname = "x"\n\n[tool.poetry.scripts]\nserve = "x.cli:main"\n',
    });
    assert.deepEqual(commandsOf(await stackOf(dir, 'python')), ['poetry run serve']);
  });

  test('a Vite + React package with no scripts is started through its package manager', async () => {
    const dir = await fixture('vite-react', {
      'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^18', typescript: '^5' } }),
      'pnpm-lock.yaml': '',
    });
    const node = await stackOf(dir, 'node');
    assert.deepEqual(node.details, ['TypeScript', 'React (Vite)']);
    assert.deepEqual(commandsOf(node), ['pnpm exec vite']);
    assert.match(node.notes[0], /pnpm install/);
  });

  test('a framework outranks the libraries it is built on', async () => {
    const dir = await fixture('next', {
      'package.json': JSON.stringify({ dependencies: { next: '14', react: '18', 'react-dom': '18' } }),
      node_modules: '',
    });
    const node = await stackOf(dir, 'node');
    assert.deepEqual(node.details, ['JavaScript', 'Next.js']);
    assert.deepEqual(commandsOf(node), ['npx next dev']);
    assert.deepEqual(node.notes, [], 'node_modules is there, so nothing to install');
  });

  test('a package that declares a dev script is reported but not second-guessed', async () => {
    const node = await stackOf(repo, 'node');
    assert.ok(node);
    assert.deepEqual(node.suggestions, []);
  });

  test("an Express server starts from package.json's main", async () => {
    const dir = await fixture('express', {
      'package.json': JSON.stringify({ main: './src/server.js', dependencies: { express: '4' } }),
      'src/server.js': '',
      'index.js': '',
    });
    const node = await stackOf(dir, 'node');
    assert.deepEqual(node.details, ['JavaScript', 'Express']);
    assert.deepEqual(commandsOf(node), ['node --watch src/server.js', 'node src/server.js']);
  });

  test('no package.json at all: a TypeScript entry file still gets a command', async () => {
    const dir = await fixture('bare-ts', { 'server.ts': 'console.log(1)' });
    const node = await stackOf(dir, 'node');
    assert.deepEqual(node.details, ['TypeScript']);
    assert.deepEqual(node.evidence, ['server.ts']);
    assert.deepEqual(commandsOf(node), ['npx tsx watch server.ts']);
  });

  test('deno.jsonc tasks, comments and all, with the ones that start something first', async () => {
    const dir = await fixture('deno', {
      'deno.jsonc': '{\n  // tasks\n  "imports": { "std/": "https://deno.land/std/" },\n  "tasks": { "test": "deno test", "dev": "deno run -A main.ts", },\n}\n',
      'main.ts': '',
    });
    assert.deepEqual(await stackOf(dir, 'node'), undefined, 'a Deno project is not a Node project');
    assert.deepEqual(commandsOf(await stackOf(dir, 'deno')), ['deno task dev', 'deno task test']);
  });

  test('Go: every main package under cmd/ is a command', async () => {
    const dir = await fixture('go', {
      'go.mod': 'module example.com/x\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      'cmd/api/main.go': 'package main',
      'cmd/worker/main.go': 'package main',
      'cmd/shared/util.go': 'package shared',
    });
    const go = await stackOf(dir, 'go');
    assert.deepEqual(go.details, ['Gin']);
    assert.deepEqual(commandsOf(go).sort(), ['go run ./cmd/api', 'go run ./cmd/worker']);
  });

  test('a virtual Cargo workspace is Rust with nothing for cargo run to run', async () => {
    const dir = await fixture('cargo-workspace', { 'Cargo.toml': '[workspace]\nmembers = ["a"]\n' });
    assert.deepEqual((await stackOf(dir, 'rust')).suggestions, []);
  });

  test('Spring Boot on Gradle goes through the wrapper when there is one', async () => {
    const dir = await fixture('spring', {
      'build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.2.0"; kotlin("jvm") }',
      gradlew: '',
    });
    const jvm = await stackOf(dir, 'jvm');
    assert.equal(jvm.label, 'Kotlin');
    assert.deepEqual(jvm.details, ['Gradle', 'Spring Boot']);
    assert.deepEqual(commandsOf(jvm), [`${platform.localCommand('gradlew')} bootRun`]);
  });

  test('declared runners come first, and only their targets that start something', async () => {
    const dir = await fixture('declared', {
      Procfile: '# processes\nweb: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\n',
      Makefile: '.PHONY: dev build\nPORT := 3000\ndev:\n\tgo run .\nbuild:\n\tgo build\n',
      'compose.yaml': 'services: {}\n',
      'go.mod': 'module x\n',
      'main.go': 'package main',
    });
    const stacks = await stacksOf(dir);
    assert.deepEqual(stacks.map((stack) => stack.id), ['procfile', 'make', 'go', 'compose']);
    assert.deepEqual(commandsOf(stacks[0]), ['bundle exec puma -C config/puma.rb', 'bundle exec sidekiq']);
    assert.deepEqual(commandsOf(stacks[1]), ['make dev']);
    assert.deepEqual(commandsOf(stacks[3]), ['docker compose up']);
  });

  test('an index.html with nothing else is a static site; inside a Node project it is not', async () => {
    const site = await fixture('static', { 'index.html': '<!doctype html>' });
    assert.deepEqual((await stacksOf(site)).map((stack) => stack.id), ['static']);

    const app = await fixture('static-in-node', {
      'index.html': '<!doctype html>',
      'package.json': JSON.stringify({ devDependencies: { vite: '5' } }),
    });
    assert.deepEqual((await stacksOf(app)).map((stack) => stack.id), ['node']);
  });

  test('a manifest too large to read costs that stack its details, not the inspection', async () => {
    const dir = await fixture('huge-gemfile', { Gemfile: `gem "rails"\n${'#'.repeat(300_000)}` });
    const ruby = await stackOf(dir, 'ruby');
    assert.deepEqual(ruby.details, []);
    assert.deepEqual(ruby.suggestions, []);
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
