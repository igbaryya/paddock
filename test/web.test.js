/**
 * Regression suite for web.js. Every service here is a real HTTP server on an ephemeral loopback
 * port, because what decides "this is a website" is what a server actually answers at `/`.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, describe, test } from 'node:test';
import * as web from '../web.js';

/** Every server this file started, closed at the end even when a test fails. */
const servers = [];

let idCounter = 0;
const nextId = () => `proc_web${(idCounter += 1)}`;

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

const answering = (status, type, body, headers = {}) => (req, res) => {
  res.writeHead(status, { ...(type && { 'Content-Type': type }), ...headers });
  res.end(body);
};

/** A detection target for a process listening on `ports`, as service.js builds it after a scan. */
const target = (ports, overrides = {}) => ({
  applicationId: 'app_test',
  processId: nextId(),
  startedAt: new Date().toISOString(),
  listeners: ports.map((port) => ({ port, addresses: ['127.0.0.1'] })),
  ...overrides,
});

const pageOf = (t) => web.describe(t.processId, t.startedAt, t.listeners.map((l) => l.port));

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('detection', () => {
  test('an HTML page at / is a website, opened on localhost, titled from the page', async () => {
    const port = await serve(
      answering(200, 'text/html; charset=utf-8', '<!doctype html><title> Samurai &amp; Co </title><body>')
    );
    const t = target([port]);

    assert.equal(await web.detect([t]), true);
    assert.deepEqual(pageOf(t), { port, url: `http://localhost:${port}/`, title: 'Samurai & Co' });
  });

  test('a redirect to a login page on the same server is still a website', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/') return answering(302, null, '', { Location: '/login' })(req, res);
      return answering(200, 'text/html', '<html><head><title>Sign in</title></head></html>')(req, res);
    });
    const t = target([port]);

    await web.detect([t]);
    assert.equal(pageOf(t)?.title, 'Sign in');
    assert.equal(pageOf(t)?.url, `http://localhost:${port}/`, 'the browser follows the redirect itself');
  });

  test('a page without a Content-Type is recognised from its markup', async () => {
    const port = await serve(answering(200, null, '<!DOCTYPE html><html><body>hi</body></html>'));
    const t = target([port]);

    await web.detect([t]);
    assert.equal(pageOf(t)?.port, port);
    assert.equal(pageOf(t)?.title, null);
  });

  test('a JSON API is not a website', async () => {
    const port = await serve(answering(200, 'application/json', '{"ok":true}'));
    const t = target([port]);

    assert.equal(await web.detect([t]), false);
    assert.equal(pageOf(t), null);
  });

  test("a framework's HTML 404 at / is not a website", async () => {
    const port = await serve(answering(404, 'text/html', '<!DOCTYPE html><pre>Cannot GET /</pre>'));
    const t = target([port]);

    await web.detect([t]);
    assert.equal(pageOf(t), null);
  });

  test('a port that does not speak HTTP is not a website', async () => {
    const server = net.createServer((socket) => socket.end('\x00\x01not http\r\n'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const t = target([server.address().port]);

    await web.detect([t]);
    assert.equal(pageOf(t), null);
  });

  test('of an API port and a page port, the page is the one offered', async () => {
    const api = await serve(answering(200, 'application/json', '{}'));
    const site = await serve(answering(200, 'text/html', '<title>UI</title>'));
    const t = target([api, site]);

    await web.detect([t]);
    assert.equal(pageOf(t)?.port, site);
  });

  test('a page far larger than its head is read only as far as needed', async () => {
    const port = await serve(
      answering(200, 'text/html', `<html><head><title>Big</title></head><body>${'x'.repeat(2_000_000)}</body>`)
    );
    const t = target([port]);

    await web.detect([t]);
    assert.equal(pageOf(t)?.title, 'Big');
  });
});

describe('what a view is told', () => {
  test('a page belongs to the run it was found in', async () => {
    const port = await serve(answering(200, 'text/html', '<title>x</title>'));
    const t = target([port]);
    await web.detect([t]);

    assert.equal(web.describe(t.processId, new Date(Date.now() + 1_000).toISOString(), [port]), null);
    assert.equal(web.describe(t.processId, null, [port]), null);
  });

  test('a page goes when its port is no longer held', async () => {
    const port = await serve(answering(200, 'text/html', '<title>x</title>'));
    const t = target([port]);
    await web.detect([t]);

    assert.equal(web.describe(t.processId, t.startedAt, []), null);
    assert.equal(web.describe(t.processId, t.startedAt, null), null);
  });

  test('a found page is not probed again within the run', async () => {
    let hits = 0;
    const port = await serve((req, res) => {
      hits += 1;
      answering(200, 'text/html', '<title>x</title>')(req, res);
    });
    const t = target([port]);

    await web.detect([t]);
    assert.equal(await web.detect([t]), false);
    assert.equal(hits, 1);
  });

  test('a forgotten process has no page', async () => {
    const port = await serve(answering(200, 'text/html', '<title>x</title>'));
    const t = target([port]);
    await web.detect([t]);

    web.forget(t.processId);
    assert.equal(pageOf(t), null);
  });
});
