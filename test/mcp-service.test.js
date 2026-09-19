/**
 * MCP preferences and listener lifecycle — hermetic, temp data directory.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let dataDir;
let savedDataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-mcp-test-'));
  savedDataDir = process.env.PADDOCK_DATA_DIR;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_MCP_PORT = '';
});

after(async () => {
  if (savedDataDir === undefined) delete process.env.PADDOCK_DATA_DIR;
  else process.env.PADDOCK_DATA_DIR = savedDataDir;
  delete process.env.PADDOCK_MCP_PORT;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('MCP does not start until installation configures a port', async () => {
  const mcpPrefs = await import('../mcp-preferences.js');
  const mcpListener = await import('../mcp-listener.js');
  const service = await import('../service.js');

  const prefs = await mcpPrefs.read();
  assert.equal(prefs.configured, false);
  assert.equal(mcpListener.status().running, false);

  await service.bootstrapMcp();
  assert.equal(mcpListener.status().running, false);
});

test('configure starts the listener and records audit entries', async () => {
  const service = await import('../service.js');
  const mcpListener = await import('../mcp-listener.js');

  const view = await service.configureMcp({ port: 47123 });
  assert.equal(view.configured, true);
  assert.equal(view.running, true);
  assert.equal(view.boundPort, 47123);
  assert.ok(view.audit.some((entry) => entry.action === 'configure'));
  assert.equal(mcpListener.status().port, 47123);

  await service.stopMcp();
  assert.equal(mcpListener.status().running, false);

  await service.startMcp();
  assert.equal(mcpListener.status().running, true);

  await service.restartMcp();
  assert.equal(mcpListener.status().running, true);
  assert.equal(mcpListener.status().port, 47123);

  await mcpListener.stop();
});
