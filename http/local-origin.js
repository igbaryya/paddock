/**
 * The local-origin check shared by the dashboard server and the MCP listener. One copy, so the two
 * front doors agree on who is allowed in.
 */
import { HOST, HOSTNAME } from '../config.js';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', HOSTNAME]);

/** @param {string} [value] */
const hostnameOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

/** Covers all of 127/8 and the IPv4-mapped form a dual-stack socket reports. */
export const isLoopbackAddress = (address = '') => {
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return addr === '::1' || addr.startsWith('127.');
};

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLocalRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (!req.headers.host) return false;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(`http://${req.headers.host}`))) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_HOSTNAMES.has(hostnameOf(origin));
}

/** @param {string} pathname */
export const isGuardedApiPath = (pathname) =>
  pathname === '/mcp' || pathname === '/api' || pathname.startsWith('/api/');
