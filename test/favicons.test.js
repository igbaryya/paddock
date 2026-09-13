/**
 * Regression suite for favicons.js. Every service here is a real HTTP server on an ephemeral
 * loopback port, because the module's job is to read what a dev server actually answers — including
 * the ways a real one lies, like a single-page app returning its HTML shell for `/favicon.ico`.
 *
 * The data directory is redirected before the first dynamic import: config.js resolves FAVICON_DIR
 * at import time, and the suite must never read or write a developer's real icon cache.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAVICONS_URL = pathToFileURL(path.join(PROJECT_ROOT, 'favicons.js')).href;

/** @type {typeof import('../favicons.js')} */
let favicons;
let dataDir;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);
const ICO = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(16)]);
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const SHELL = '<!doctype html><html><head><title>app</title></head><body></body></html>';

/** Every server this file started, closed at the end even when a test fails. */
const servers = [];

let idCounter = 0;
const nextId = () => `proc_test${(idCounter += 1)}`;

/**
 * A service answering from a route table; any path not in it gets the HTML shell with a 200, which
 * is exactly what Vite and every other SPA dev server do.
 * @param {Record<string, {type?: string, body: string|Buffer, status?: number, headers?: object}>} routes
 */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url] ?? { type: 'text/html', body: SHELL };
    res.writeHead(route.status ?? 200, { 'Content-Type': route.type ?? 'text/html', ...route.headers });
    res.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

/** A discovery target for a process listening on `port`, as service.js builds it after a scan. */
const target = (port, overrides = {}) => ({
  applicationId: 'app_test',
  processId: nextId(),
  startedAt: new Date().toISOString(),
  listeners: [{ port, addresses: ['127.0.0.1'] }],
  ...overrides,
});

const iconOf = (processId) => favicons.list(new Set([processId]))[processId];

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-favicons-'));
  process.env.PADDOCK_DATA_DIR = dataDir;
  favicons = await import(FAVICONS_URL);
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe('discovery', () => {
  test('takes the icon the page declares, over /favicon.ico', async () => {
    const port = await serve({
      '/': { body: '<html><head><link rel="icon" type="image/svg+xml" href="/brand.svg"></head></html>' },
      '/brand.svg': { type: 'image/svg+xml', body: SVG },
      '/favicon.ico': { type: 'image/x-icon', body: ICO },
    });
    const t = target(port);

    assert.equal(await favicons.discover([t]), true);
    const icon = iconOf(t.processId);
    assert.equal(icon.sourceUrl, `http://127.0.0.1:${port}/brand.svg`);
    assert.match(icon.dataUrl, /^data:image\/svg\+xml;base64,/);
  });

  test('falls back to /favicon.ico when the page declares nothing', async () => {
    const port = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    const t = target(port);

    await favicons.discover([t]);
    assert.equal(iconOf(t.processId).sourceUrl, `http://127.0.0.1:${port}/favicon.ico`);
    assert.match(iconOf(t.processId).dataUrl, /^data:image\/x-icon;base64,/);
  });

  // The failure a header check cannot catch: every path, /favicon.ico included, gets the app shell.
  test('an SPA answering /favicon.ico with its HTML shell has no icon', async () => {
    const t = target(await serve({}));
    assert.equal(await favicons.discover([t]), false);
    assert.equal(favicons.describe(t.processId), null);
  });

  test('the image type comes from the bytes, not from what the server claims', async () => {
    const port = await serve({
      '/': { body: '<link rel="shortcut icon" href="icon">' },
      '/icon': { type: 'application/octet-stream', body: PNG },
    });
    const t = target(port);

    await favicons.discover([t]);
    assert.match(iconOf(t.processId).dataUrl, /^data:image\/png;base64,/);
  });

  test('an icon inlined as a data URL is found, and its source is the page', async () => {
    const inline = `data:image/png;base64,${PNG.toString('base64')}`;
    const port = await serve({ '/': { body: `<link href='${inline}' rel='icon'>` } });
    const t = target(port);

    await favicons.discover([t]);
    assert.equal(iconOf(t.processId).sourceUrl, `http://127.0.0.1:${port}/ (inline)`);
  });

  test('a declared icon that fails is skipped for the next candidate', async () => {
    const port = await serve({
      '/': { body: '<link rel="icon" href="/missing.png"><link rel="apple-touch-icon" href="/touch.png">' },
      '/missing.png': { status: 404, type: 'text/plain', body: 'nope' },
      '/touch.png': { type: 'image/png', body: PNG },
    });
    const t = target(port);

    await favicons.discover([t]);
    assert.equal(iconOf(t.processId).sourceUrl, `http://127.0.0.1:${port}/touch.png`);
  });

  test('a service that is not HTTP at all is simply one without an icon', async () => {
    const raw = net.createServer((socket) => socket.end('-ERR not http\r\n'));
    await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
    servers.push(raw);
    const t = target(raw.address().port);

    assert.equal(await favicons.discover([t]), false);
  });

  // Proven against a server that really does have an icon, on this machine's LAN address: pointing
  // at an unreachable host would pass just as well if the loopback rule did not exist.
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((nic) => nic?.family === 'IPv4' && !nic.internal)?.address;

  test('never follows a page off loopback', { skip: !lanAddress && 'no LAN address' }, async () => {
    let offLoopbackRequests = 0;
    const lan = http.createServer((req, res) => {
      offLoopbackRequests += 1;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    });
    await new Promise((resolve) => lan.listen(0, lanAddress, resolve));
    servers.push(lan);
    const elsewhere = `http://${lanAddress}:${lan.address().port}`;

    const port = await serve({
      '/': { body: `<link rel="icon" href="${elsewhere}/icon.png">` },
      '/favicon.ico': { status: 302, body: '', headers: { Location: `${elsewhere}/favicon.ico` } },
    });
    const t = target(port);

    assert.equal(await favicons.discover([t]), false);
    assert.equal(offLoopbackRequests, 0);
  });

  test('follows a redirect that stays on loopback', async () => {
    const port = await serve({
      '/favicon.ico': { status: 301, body: '', headers: { Location: '/static/favicon.ico' } },
      '/static/favicon.ico': { type: 'image/x-icon', body: ICO },
    });
    const t = target(port);

    await favicons.discover([t]);
    assert.equal(iconOf(t.processId).sourceUrl, `http://127.0.0.1:${port}/favicon.ico`);
  });

  test('a listener bound to a LAN address is not probed', async () => {
    const t = target(1, { listeners: [{ port: 1, addresses: ['192.168.1.20'] }] });
    assert.equal(await favicons.discover([t]), false);
  });
});

describe('the cache', () => {
  test('finding the same icon again is not a change', async () => {
    const port = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    const first = target(port);
    await favicons.discover([first]);

    // A restart: a new run of the same process, which always gets a fresh attempt.
    const restarted = { ...first, startedAt: new Date(Date.now() + 1_000).toISOString() };
    assert.equal(await favicons.discover([restarted]), false);
  });

  test('a failed run does not retry on the very next scan', async () => {
    const t = target(await serve({}));
    await favicons.discover([t]);

    let requests = 0;
    const counting = http.createServer((req, res) => {
      requests += 1;
      res.end(SHELL);
    });
    await new Promise((resolve) => counting.listen(0, '127.0.0.1', resolve));
    servers.push(counting);

    await favicons.discover([{ ...t, listeners: [{ port: counting.address().port, addresses: ['127.0.0.1'] }] }]);
    assert.equal(requests, 0, 'the same run was probed again before its retry delay');
  });

  test('survives a restart of the manager: written to disk, read back by load()', async () => {
    const port = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    const t = target(port);
    await favicons.discover([t]);

    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'favicons', `${t.processId}.json`), 'utf8'));
    assert.equal(onDisk.contentType, 'image/x-icon');

    // A fresh module instance is a fresh manager process as far as the cache is concerned.
    const fresh = await import(`${FAVICONS_URL}?restart=${Date.now()}`);
    await fresh.load();
    assert.equal(fresh.describe(t.processId).sourceUrl, `http://127.0.0.1:${port}/favicon.ico`);
  });

  test('a torn or hand-edited cache entry is ignored, not fatal', async () => {
    const dir = path.join(dataDir, 'favicons');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'proc_torn.json'), '{"processId":"proc_to');
    await fs.writeFile(
      path.join(dir, 'proc_lying.json'),
      JSON.stringify({ processId: 'proc_other', applicationId: 'a', sourceUrl: 's', contentType: 'image/png', fetchedAt: 'x', data: '' })
    );
    await favicons.load();
    assert.equal(favicons.describe('proc_torn'), null);
    assert.equal(favicons.describe('proc_other'), null, 'an entry must be stored under its own id');
  });

  test('list only returns icons for processes that still exist', async () => {
    const port = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    const t = target(port);
    await favicons.discover([t]);

    assert.deepEqual(Object.keys(favicons.list(new Set(['proc_someone_else']))), []);
  });

  test('forget drops the icon from memory and from disk', async () => {
    const port = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    const t = target(port);
    await favicons.discover([t]);

    favicons.forget(t.processId);
    assert.equal(favicons.describe(t.processId), null);
    const file = path.join(dataDir, 'favicons', `${t.processId}.json`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await fs.access(file).then(() => true, () => false))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('the cache file was not removed');
  });
});
