/**
 * platform/desktop.js — the login entry under the desktop app, asked of the app over the utility
 * process's parent port.
 *
 * Electron is not needed: `process.parentPort` is replaced by an emitter playing the app's half of
 * the protocol before any project module is loaded, which is exactly when platform/index.js decides
 * which implementation serves login items. The app's own half (desktop/login-item.js) needs
 * Electron and is exercised by running the app.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-desktop-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;

/** What the fake app answers, per action; a function throws to answer with an error. */
const answers = {
  'loginItem.status': () => ({ supported: true, reason: null, note: null, installed: false, location: 'Login Items', startNowCommand: null }),
  'loginItem.enable': () => undefined,
  'loginItem.disable': () => {
    throw new Error('the OS refused');
  },
};

/** @type {object[]} */
const received = [];

const port = new EventEmitter();
port.postMessage = (message) => {
  received.push(message);
  const answer = answers[message.action];
  setImmediate(() => {
    try {
      port.emit('message', { data: { type: 'reply', id: message.id, result: answer() } });
    } catch (err) {
      port.emit('message', { data: { type: 'reply', id: message.id, error: err.message } });
    }
  });
};
process.parentPort = port;

const platform = await import('../platform/index.js');

after(() => {
  delete process.parentPort;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('login entry under the desktop app', () => {
  test('platform/ routes it to the app rather than to the OS entry', async () => {
    const status = await platform.loginItemStatus({ label: 'ignored' });
    assert.equal(status.location, 'Login Items');
    assert.equal(received.at(-1).type, 'request');
    assert.equal(received.at(-1).action, 'loginItem.status');
  });

  test('the spec is not sent: the app decides what a login opens', async () => {
    await platform.installLoginItem({ label: 'ignored', program: '/somewhere/node' });
    assert.deepEqual(Object.keys(received.at(-1)).sort(), ['action', 'id', 'type']);
  });

  test("the app's error reaches the caller with the app's text", async () => {
    await assert.rejects(platform.removeLoginItem({}), /the OS refused/);
  });

  test('concurrent requests each get their own reply', async () => {
    const [first, second] = await Promise.all([platform.loginItemStatus({}), platform.installLoginItem({})]);
    assert.equal(first.location, 'Login Items');
    assert.equal(second, undefined);
  });

  test('replies to nobody, and messages that are not replies, are ignored', async () => {
    port.emit('message', { data: { type: 'reply', id: 999_999, result: 'stray' } });
    port.emit('message', { data: { type: 'shutdown' } });
    port.emit('message', { data: null });
    assert.equal((await platform.loginItemStatus({})).installed, false);
  });
});
