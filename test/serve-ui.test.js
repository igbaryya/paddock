/**
 * The desktop app from a checkout does not serve the dashboard. The API stays up; a browser that
 * opens the port does not get the "not built" page or a built SPA.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PADDOCK_SERVE_UI=0 serves the API and not the dashboard', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-serve-ui-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: dataDir,
      PADDOCK_PORT: '0',
      PADDOCK_HOST: '127.0.0.1',
      PADDOCK_ENV_FILE: path.join(dataDir, 'absent.env'),
      PADDOCK_REAP_ORPHANS: 'false',
      PADDOCK_MCP_AUTO_CONFIGURE: 'false',
      PADDOCK_SERVE_UI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server never announced a port.\n${stdout}\n${stderr}`)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/API\s+http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}: ${stderr}`)));
  });

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const text = await page.text();
    assert.equal(page.status, 404);
    assert.equal(/text\/html/.test(page.headers.get('content-type') ?? ''), false);
    assert.equal(text.includes('dashboard has not been built'), false);
    assert.equal(text.includes('<div id="root">'), false);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'paddock');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
