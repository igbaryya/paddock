/**
 * mcp-clients.js against a fake home directory: detection, the suggestion, and writing Paddock's
 * entry into each client's settings without disturbing anything else in the file.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const URL_NOW = 'http://127.0.0.1:4600/mcp';

let root;
let home;
let clients;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-mcp-clients-')));
  process.env.PADDOCK_DATA_DIR = path.join(root, 'data');
  clients = await import('../mcp-clients.js');
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(root, 'home-'));
});

after(async () => {
  delete process.env.PADDOCK_DATA_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

const byId = (list) => Object.fromEntries(list.map((client) => [client.id, client]));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const cursorFile = () => path.join(home, '.cursor', 'mcp.json');
const claudeFile = () => path.join(home, '.claude.json');

/** Set a marker's modification time, which is what ranks two installed clients. */
const touch = (file, secondsAgo) => {
  const at = new Date(Date.now() - secondsAgo * 1_000);
  return fs.utimes(file, at, at);
};

test('nothing installed: both listed, neither detected, nothing suggested', async () => {
  const list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list.cursor.detected, false);
  assert.equal(list['claude-code'].detected, false);
  assert.equal(list.cursor.state, 'missing');
  assert.equal(list.cursor.displayPath, path.join('~', '.cursor', 'mcp.json'));
  assert.equal(list.cursor.suggested || list['claude-code'].suggested, false);
});

test('of two installed clients, the one used most recently is suggested', async () => {
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(claudeFile(), '{}');
  await touch(path.join(home, '.cursor'), 3_600);
  await touch(claudeFile(), 10);
  let list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list['claude-code'].suggested, true);
  assert.equal(list.cursor.suggested, false);

  await clients.install('claude-code', { home, url: URL_NOW });
  list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list['claude-code'].state, 'configured');
  assert.equal(list.cursor.suggested, true, 'the client that still lacks Paddock is suggested next');
});

test('Cursor gets a url entry and keeps the servers already in the file', async () => {
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(cursorFile(), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  await clients.install('cursor', { home, url: URL_NOW });
  assert.deepEqual(await readJson(cursorFile()), {
    mcpServers: { other: { command: 'x' }, paddock: { url: URL_NOW } },
  });
});

test('Claude Code gets an http entry in its user scope and keeps every other key', async () => {
  await fs.writeFile(claudeFile(), JSON.stringify({ numStartups: 4, projects: { '/x': {} } }), { mode: 0o600 });
  await clients.install('claude-code', { home, url: URL_NOW });
  const doc = await readJson(claudeFile());
  assert.deepEqual(doc, {
    numStartups: 4,
    projects: { '/x': {} },
    mcpServers: { paddock: { type: 'http', url: URL_NOW } },
  });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(claudeFile())).mode & 0o777, 0o600, 'the file keeps its mode');
  }
});

test('a missing settings file and its directory are created', async () => {
  await clients.install('cursor', { home, url: URL_NOW });
  assert.deepEqual(await readJson(cursorFile()), { mcpServers: { paddock: { url: URL_NOW } } });
});

test('an entry on another port is stale, and installing again points it at the current URL', async () => {
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(cursorFile(), JSON.stringify({ mcpServers: { paddock: { url: 'http://127.0.0.1:4700/mcp' } } }));
  let list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list.cursor.state, 'stale');
  assert.equal(list.cursor.configuredUrl, 'http://127.0.0.1:4700/mcp');
  assert.equal(list.cursor.suggested, true);

  await clients.install('cursor', { home, url: URL_NOW });
  list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list.cursor.state, 'configured');
});

test('localhost and 127.0.0.1 on the same port are the same server', async () => {
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(cursorFile(), JSON.stringify({ mcpServers: { paddock: { url: 'http://localhost:4600/mcp' } } }));
  const list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list.cursor.state, 'configured');
});

test('a settings file that is not JSON is reported and never overwritten', async () => {
  await fs.mkdir(path.join(home, '.cursor'));
  await fs.writeFile(cursorFile(), '{ broken');
  const list = byId(await clients.list({ home, url: URL_NOW }));
  assert.equal(list.cursor.state, 'unreadable');
  assert.match(list.cursor.error, /not valid JSON/);
  await assert.rejects(clients.install('cursor', { home, url: URL_NOW }), { name: 'ValidationError' });
  assert.equal(await fs.readFile(cursorFile(), 'utf8'), '{ broken');
});

test('a symlinked settings file is written through, and stays a link', { skip: process.platform === 'win32' }, async () => {
  const real = path.join(home, 'dotfiles-claude.json');
  await fs.writeFile(real, '{}');
  await fs.symlink(real, claudeFile());
  await clients.install('claude-code', { home, url: URL_NOW });
  assert.equal((await fs.lstat(claudeFile())).isSymbolicLink(), true);
  assert.deepEqual((await readJson(real)).mcpServers.paddock, { type: 'http', url: URL_NOW });
});

test('an unknown client is NotFound, and no URL is a validation error', async () => {
  await assert.rejects(clients.install('vim', { home, url: URL_NOW }), { name: 'NotFoundError' });
  await assert.rejects(clients.install('cursor', { home, url: null }), /MCP is not installed/);
});
