/**
 * links.js — accumulating what a scan saw into the arrows a canvas draws, and keeping them on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;

const links = await import(new URL('../links.js', import.meta.url).href);
const { LINKS_FILE } = await import(new URL('../config.js', import.meta.url).href);

const target = (over = {}) => ({
  kind: 'managed',
  applicationId: 'app_1',
  applicationName: 'Acme',
  processId: 'proc_api',
  processName: 'api',
  name: 'node',
  ...over,
});

const link = (over = {}) => ({ applicationId: 'app_1', processId: 'proc_fe', port: 3001, target: target(), ...over });

test('a new link is a change; seeing it again is not; a new target behind the port is', () => {
  assert.equal(links.record([link()]), true);
  assert.equal(links.record([link()]), false);
  assert.equal(links.record([link({ target: target({ kind: 'unmanaged', processId: null, name: 'python' }) })]), true);
  assert.equal(links.of('app_1').length, 1);
  assert.equal(links.of('app_1')[0].target.name, 'python');
});

test('links survive a reload from disk, and a stale one is dropped on the way in', async () => {
  links.record([link({ port: 6379, target: target({ kind: 'unmanaged', processId: null, name: 'redis-server' }) })]);
  await links.flush();
  const stored = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  stored.links.push({ ...link({ port: 1111 }), firstSeenAt: '2020-01-01T00:00:00.000Z', lastSeenAt: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(stored));

  const fresh = await import(new URL('../links.js?reload', import.meta.url).href);
  await fresh.load();
  assert.deepEqual(fresh.of('app_1').map((l) => l.port), [3001, 6379]);
});

test('forgetting a process drops the links it made and the links made to it', () => {
  links.record([link({ processId: 'proc_worker', port: 3001 })]);
  links.forget('app_1', 'proc_api');
  assert.ok(links.of('app_1').every((l) => l.target.processId !== 'proc_api'));
  links.forget('app_1', 'proc_fe');
  assert.ok(links.of('app_1').every((l) => l.processId !== 'proc_fe'));
});
