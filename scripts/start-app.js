/**
 * `npm start`: the desktop app, not a browser. Electron opens the window; it starts the API and
 * the UI itself. This file only checks the two installs that are not the server's, then hands off.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_BIN = path.join(ROOT, 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
const ELECTRON_CLI = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'cli.js');

if (!fs.existsSync(VITE_BIN)) {
  console.error('[paddock] the UI is not installed yet — run `npm run setup` first');
  process.exit(1);
}
if (!fs.existsSync(ELECTRON_CLI)) {
  console.error('[paddock] the desktop app is not installed yet — run `npm run desktop:setup` first');
  process.exit(1);
}

const child = spawn(process.execPath, [ELECTRON_CLI, '.'], {
  cwd: path.join(ROOT, 'desktop'),
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error(`[paddock] failed to open the app: ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
