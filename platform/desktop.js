/**
 * The login entry under the desktop app. There the server runs in an Electron utility process, and
 * the entry is the app itself — a Login Item on macOS, a Run key value on Windows — which only
 * Electron can register, and only from the app's main process. So these three ask the app, over the
 * port the utility process was forked with, and answer in the shape posix.js and win32.js answer in.
 *
 * The app decides everything about the entry, so the spec is not sent: what a login starts is the
 * app, whatever this server would have named.
 *
 * The protocol, both halves of which are in this file and desktop/login-item.js:
 *   server → app  {type: 'request', id, action}
 *   app → server  {type: 'reply', id, result} | {type: 'reply', id, error}
 */

/** Registering can wait on the OS, but an app that never answers must not hang the Settings screen. */
const REPLY_TIMEOUT_MS = 10_000;

/** @type {Map<number, {resolve: (value: unknown) => void, reject: (err: Error) => void}>} */
const pending = new Map();

let nextId = 1;

process.parentPort?.on('message', ({ data }) => {
  if (data?.type !== 'reply') return;
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
});

/**
 * @param {string} action
 * @returns {Promise<any>}
 */
function ask(action) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the desktop app did not answer ${action} within ${REPLY_TIMEOUT_MS / 1_000} s`));
    }, REPLY_TIMEOUT_MS);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    process.parentPort.postMessage({ type: 'request', id, action });
  });
}

export const loginItemStatus = () => ask('loginItem.status');

export const installLoginItem = () => ask('loginItem.enable');

export const removeLoginItem = () => ask('loginItem.disable');
