/**
 * Open MCP sessions — who is connected right now, and the handle that ends each connection.
 *
 * A session is opened by an agent's `initialize` and lives until the agent sends DELETE, the
 * listener stops, or it sits idle past `MCP_SESSION_IDLE_MS`. Every one of those ends the same way:
 * the handle's `close()` closes the transport, and the transport's own close is what calls
 * `remove()` here — one exit path, so the registry can never list a session that is gone.
 */
import { MCP_MAX_SESSIONS, MCP_SESSION_IDLE_MS } from './config.js';

/** "Connected" in the view: seen within this window. Idle sessions stay open, just not active. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
const REAP_INTERVAL_MS = 60_000;

/**
 * @typedef {{id:string, client:{name:string, version:string}|null, openedAt:number,
 *            lastSeenAt:number, calls:number, close:() => Promise<void>}} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

let reaper = null;

/**
 * @param {string} id
 * @param {() => Promise<void>} close ends the transport; the transport then calls `remove(id)`
 */
export function open(id, close) {
  if (sessions.size >= MCP_MAX_SESSIONS) closeLeastRecent();
  const now = Date.now();
  sessions.set(id, { id, client: null, openedAt: now, lastSeenAt: now, calls: 0, close });
  startReaper();
}

export const has = (id) => sessions.has(id);

/** @param {string} id @param {{name:string, version:string}|undefined} client */
export function identify(id, client) {
  const session = sessions.get(id);
  if (session && client) session.client = { name: client.name, version: client.version };
}

/** @param {string} id @returns {{name:string, version:string}|null} */
export const clientOf = (id) => sessions.get(id)?.client ?? null;

/** Any request on the session, a tool call or not, keeps it alive. */
export function touch(id, { call = false } = {}) {
  const session = sessions.get(id);
  if (!session) return;
  session.lastSeenAt = Date.now();
  if (call) session.calls += 1;
}

/** @returns {boolean} whether it was registered */
export function remove(id) {
  const removed = sessions.delete(id);
  if (!sessions.size) stopReaper();
  return removed;
}

/** Most recently seen first. */
export function list() {
  const now = Date.now();
  return [...sessions.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(({ id, client, openedAt, lastSeenAt, calls }) => ({
      id,
      client,
      openedAt: new Date(openedAt).toISOString(),
      lastSeenAt: new Date(lastSeenAt).toISOString(),
      active: now - lastSeenAt < ACTIVE_WINDOW_MS,
      calls,
    }));
}

/** Close every session — the listener is stopping, and no transport may outlive it. */
export async function closeAll() {
  await Promise.all([...sessions.values()].map(closeQuietly));
}

function closeLeastRecent() {
  let oldest = null;
  for (const session of sessions.values()) {
    if (!oldest || session.lastSeenAt < oldest.lastSeenAt) oldest = session;
  }
  if (oldest) void closeQuietly(oldest);
}

function reapIdle() {
  const cutoff = Date.now() - MCP_SESSION_IDLE_MS;
  for (const session of sessions.values()) {
    if (session.lastSeenAt < cutoff) void closeQuietly(session);
  }
}

/** A close that fails still has to drop the entry, or a dead session is listed forever. */
const closeQuietly = (session) =>
  session.close().catch(() => {}).finally(() => remove(session.id));

function startReaper() {
  if (reaper) return;
  reaper = setInterval(reapIdle, REAP_INTERVAL_MS);
  reaper.unref();
}

function stopReaper() {
  clearInterval(reaper);
  reaper = null;
}
