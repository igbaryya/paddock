/**
 * First run with auto-configure on — its own file, because config.js reads the switch once, at
 * import time. The default port is held for the duration so the fallback is what gets exercised,
 * and the test never binds the developer's own 4600.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let dataDir;
let holder = null;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-mcp-auto-test-'));
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_ENV_FILE = path.join(dataDir, 'absent.env');
  process.env.PADDOCK_MCP_PORT = '';
  process.env.PADDOCK_MCP_AUTO_CONFIGURE = 'true';
  holder = net.createServer();
  // Something else may already hold 4600 on this machine; either way it is taken for the test.
  await new Promise((resolve) => {
    holder.once('error', () => { holder = null; resolve(); });
    holder.listen(4600, '127.0.0.1', resolve);
  });
});

after(async () => {
  if (holder) await new Promise((resolve) => holder.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a fresh install brings MCP up by itself, on a free port when the default is taken', async () => {
  const service = await import('../service.js');
  const mcpPrefs = await import('../mcp-preferences.js');

  await service.bootstrapMcp();
  const view = await service.getMcp();
  assert.equal(view.running, true);
  assert.equal(view.configured, true);
  assert.notEqual(view.boundPort, 4600);
  assert.ok(view.audit.some((entry) => entry.action === 'auto_configure'));

  const stored = await mcpPrefs.read();
  assert.equal(stored.port, view.boundPort, 'the port it got is kept, so the URL survives a restart');
  await service.stopMcp();
});
