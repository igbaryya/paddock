/**
 * Development runner: the manager and the Vite dev server in one terminal, every line labelled with
 * the process it came from, one Ctrl-C taking both down. It has no dependencies of its own, so
 * `npm run dev` works with nothing installed but the server's own packages.
 *
 * Vite is launched as `node ui/node_modules/vite/bin/vite.js` rather than through `npm`: it removes
 * a layer of signal forwarding that otherwise swallows the shutdown, and it works on Windows, where
 * `npm` is a shell script. Both children are spawned as their own killable unit, so teardown is
 * explicit here instead of depending on how the terminal happened to deliver the signal.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnOptions, signalTree } from '../platform/index.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_BIN = path.join(ROOT_DIR, 'ui', 'node_modules', 'vite', 'bin', 'vite.js');

/** How long a child gets after the polite signal before it is killed outright. */
const FORCE_KILL_MS = 5_000;

const COLORS = { server: '[36m', ui: '[35m' };

/** isTTY is `undefined` rather than `false` on a pipe, so this must be a truthiness test. */
const label = (name) => {
  const text = `[${name.padEnd(6)}]`;
  return process.stdout.isTTY ? `${COLORS[name]}${text}[0m` : text;
};

/** @type {{name: string, child: import('child_process').ChildProcess}[]} */
const children = [];

let shuttingDown = false;

/**
 * Write every complete line with its label. The residual buffer is load-bearing twice over: chunk
 * boundaries land mid-line under a chatty dev server, and the last line before exit usually has no
 * trailing newline at all.
 * @param {import('stream').Readable} stream
 * @param {string} prefix
 * @param {NodeJS.WritableStream} out
 */
function prefixLines(stream, prefix, out) {
  let residual = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (residual + chunk).split('\n');
    residual = lines.pop();
    for (const line of lines) out.write(`${prefix} ${line.replace(/\r$/, '')}\n`);
  });
  stream.on('end', () => {
    if (residual) out.write(`${prefix} ${residual}\n`);
    residual = '';
  });
}

/**
 * @param {string} name label for this child's output
 * @param {string} cwd Vite resolves its project root from the working directory
 * @param {string[]} args argv for a fresh node process
 */
function launch(name, cwd, args) {
  const env = process.env;
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    // stdin stays a pipe we never write to and never end: a dev server handed /dev/null sees an
    // immediate EOF, and several of them quit on it.
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions({ cwd, env }),
  });
  prefixLines(child.stdout, label(name), process.stdout);
  prefixLines(child.stderr, label(name), process.stderr);
  child.on('error', (err) => {
    console.error(`${label(name)} failed to start: ${err.message}`);
    process.exitCode = 1;
    shutdown();
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${label(name)} exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    process.exitCode = code ?? 1;
    shutdown();
  });
  children.push({ name, child });
  return child;
}

/**
 * "Not running", covering all three ways that happens. A child killed by a signal reports
 * `exitCode === null` for good, so both exit fields must be tested; and a child that failed to spawn
 * has no pid and emits 'error' *instead of* 'exit', so waiting on 'exit' there waits forever.
 * @param {import('child_process').ChildProcess} child
 */
const hasExited = (child) =>
  typeof child.pid !== 'number' || child.exitCode !== null || child.signalCode !== null;

/** @param {import('child_process').ChildProcess} child */
const waitForExit = (child) =>
  hasExited(child) ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));

/** @param {import('child_process').ChildProcess} child @param {boolean} force */
const signalGroup = (child, force) =>
  hasExited(child) ? Promise.resolve() : signalTree(child.pid, { force }).catch(() => {});

async function shutdown() {
  // A second Ctrl-C skips the rest of the grace period rather than being swallowed. It must not
  // exit here: the kills are asynchronous, and leaving early is how a dev server gets orphaned.
  if (shuttingDown) {
    for (const { child } of children) signalGroup(child, true);
    return;
  }
  shuttingDown = true;
  // Never .unref()'d: once the children's pipes are the only handles left, an unref'd timer cannot
  // fire, and the SIGKILL escalation would simply never happen.
  const force = setTimeout(() => {
    for (const { child } of children) signalGroup(child, true);
  }, FORCE_KILL_MS);
  await Promise.all(
    children.map(async ({ child }) => {
      await signalGroup(child, false);
      await waitForExit(child);
    })
  );
  clearTimeout(force);
}

if (!fs.existsSync(VITE_BIN)) {
  console.error('[paddock] the UI is not installed yet — run `npm run setup` first');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown());

launch('server', ROOT_DIR, [path.join(ROOT_DIR, 'server.js')]);
// Vite never clears the screen here: its output is a pipe, and clearScreen is TTY-gated.
launch('ui', path.join(ROOT_DIR, 'ui'), [VITE_BIN]);
