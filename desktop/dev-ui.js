/**
 * The dashboard while running from a checkout: Vite, not a built `ui/dist`. The Electron window is
 * the only client. A browser that opens the same port is refused, because every request from the
 * window carries a token this process minted and Vite checks.
 *
 * Vite is started as Node via `ELECTRON_RUN_AS_NODE`. `process.execPath` in here is the Electron
 * binary, and spawning it without that variable would open a second copy of the app.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const VITE_BIN = path.join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

/** First start compiles the app; a hung Vite must not leave the splash up forever. */
const READY_TIMEOUT_MS = 60_000;

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * @returns {Promise<{url: string, token: string, stop: () => void}>}
 */
export function startDevUi() {
  if (!fs.existsSync(VITE_BIN)) {
    return Promise.reject(new Error('The UI is not installed yet. From the checkout, run: npm run setup'));
  }

  const token = randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [VITE_BIN], {
    cwd: UI_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PADDOCK_UI_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let settled = false;

  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
  };

  return new Promise((resolve, reject) => {
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(`The dashboard did not start.\n${stripAnsi(output)}`), READY_TIMEOUT_MS);

    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (settled) return;
      const match = stripAnsi(output).match(/Local:\s+(http:\/\/(?:127\.0\.0\.1|localhost):\d+)/);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: `${match[1].replace(/\/$/, '')}/`, token, stop });
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => fail(err.message));
    child.on('exit', (code) => fail(`The dashboard dev server exited (${code ?? 'no code'}).\n${stripAnsi(output)}`));
  });
}
