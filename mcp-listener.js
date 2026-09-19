/**
 * The MCP HTTP listener — a separate port from the dashboard, started only after installation.
 *
 * Agents connect here; the UI server stays on `PADDOCK_PORT`. That split is what makes start/stop/
 * restart of MCP meaningful without taking the dashboard down with it.
 */
import http from 'http';
import { HOST } from './config.js';
import { handleMcp } from './http/mcp.js';
import { isLocalRequest } from './http/local-origin.js';
import { json } from './http/respond.js';

/** @type {import('http').Server|null} */
let server = null;

/** @type {number|null} */
let boundPort = null;

/** @returns {{running: boolean, port: number|null}} */
export function status() {
  return { running: server !== null, port: boundPort };
}

/**
 * @param {number} port
 * @returns {Promise<number>} the port actually bound
 */
export function start(port) {
  if (server) return Promise.reject(new Error('MCP listener is already running'));
  return new Promise((resolve, reject) => {
    const listener = http.createServer((req, res) => {
      const pathname = req.url?.split('?')[0] ?? '';
      if (!isLocalRequest(req)) {
        return json(res, 403, { error: { message: 'local requests only', code: 'forbidden' } });
      }
      if (pathname !== '/mcp') {
        return json(res, 404, { error: { message: 'not found', code: 'not_found' } });
      }
      handleMcp(req, res).catch((err) => {
        console.error(`[paddock] MCP ${req.method} failed:`, err.message);
        if (res.headersSent) return res.destroy();
        json(res, 500, { error: { message: err.message, code: 'internal_error' } });
      });
    });
    listener.on('error', reject);
    listener.listen(port, HOST, () => {
      server = listener;
      boundPort = /** @type {import('net').AddressInfo} */ (listener.address()).port;
      resolve(boundPort);
    });
  });
}

/** @returns {Promise<void>} */
export function stop() {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closing = server;
    server = null;
    boundPort = null;
    closing.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * @param {number} port
 * @returns {Promise<number>}
 */
export async function restart(port) {
  await stop();
  return start(port);
}
