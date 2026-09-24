/**
 * MCP preferences and listener lifecycle — hermetic, temp data directory.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

let dataDir;
let savedDataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-mcp-test-'));
  savedDataDir = process.env.PADDOCK_DATA_DIR;
  process.env.PADDOCK_DATA_DIR = dataDir;
  process.env.PADDOCK_MCP_PORT = '';
  // Auto-configure has its own file; here installation has to be explicit.
  process.env.PADDOCK_MCP_AUTO_CONFIGURE = 'false';
});

after(async () => {
  if (savedDataDir === undefined) delete process.env.PADDOCK_DATA_DIR;
  else process.env.PADDOCK_DATA_DIR = savedDataDir;
  delete process.env.PADDOCK_MCP_PORT;
  delete process.env.PADDOCK_MCP_AUTO_CONFIGURE;
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

/** Hold a port for the length of a test, the way another program on the machine would. */
async function occupy() {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  return { port: holder.address().port, release: () => new Promise((resolve) => holder.close(resolve)) };
}

test('a port out of range is a validation error, not an internal one', async () => {
  const service = await import('../service.js');
  await assert.rejects(service.configureMcp({ port: 70_000 }), { name: 'ValidationError' });
});

test('a port change onto a taken port restores the previous one and says why', async () => {
  const service = await import('../service.js');
  const mcpListener = await import('../mcp-listener.js');
  const taken = await occupy();
  try {
    await service.configureMcp({ port: 47124 });
    await assert.rejects(service.updateMcp({ port: taken.port }), { code: 'EADDRINUSE' });

    assert.equal(mcpListener.status().running, true);
    assert.equal(mcpListener.status().port, 47124);
    const view = await service.getMcp();
    assert.equal(view.lastError, null, 'the restored bind succeeded, so nothing is wrong now');
    assert.ok(view.audit.some((entry) => entry.action === 'start_failed'));
    assert.ok(view.audit.some((entry) => entry.action === 'restore'));
  } finally {
    await taken.release();
    await service.stopMcp();
  }
});

test('a start that fails at boot is kept in the view instead of only logged', async () => {
  const service = await import('../service.js');
  const taken = await occupy();
  try {
    await service.updateMcp({ port: taken.port });
    await service.updateMcp({ enabled: true }).catch(() => {});
    await service.bootstrapMcp();
    const view = await service.getMcp();
    assert.equal(view.running, false);
    assert.equal(view.lastError.code, 'EADDRINUSE');
  } finally {
    await taken.release();
  }
});
