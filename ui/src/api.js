/**
 * Every HTTP call the dashboard makes to the manager. The manager answers failures as
 * `{ error: { message, code } }`, so this is also the single place that unwraps that envelope:
 * components surface the server's own words instead of a message invented in the browser.
 */

const API = '/api';

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string|null} code
   * @param {{code?: string, detail?: string, hint?: string, where?: string, position?: string}|null}
   *   [database] what PostgreSQL said beyond the message, when the failure was its
   */
  constructor(message, status, code, database = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.database = database;
  }
}

/** The dashboard opens exactly one EventSource against this. */
export const EVENTS_URL = `${API}/events`;

const appPath = (applicationId) => `/applications/${encodeURIComponent(applicationId)}`;
const procPath = (applicationId, processId) =>
  `${appPath(applicationId)}/processes/${encodeURIComponent(processId)}`;

/**
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path relative to /api
 * @param {{body?: object, signal?: AbortSignal}} [options]
 */
async function request(method, path, options = {}) {
  const { body, signal } = options;
  const res = await fetch(`${API}${path}`, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  // A 500 from a crashed handler may not be JSON at all; fall back to the status line.
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = payload?.error?.message ?? `${method} ${path} failed (HTTP ${res.status})`;
    throw new ApiError(message, res.status, payload?.error?.code ?? null, payload?.error?.database ?? null);
  }
  return payload;
}

/** @param {AbortSignal} [signal] */
export const listApplications = (signal) => request('GET', '/applications', { signal });

/** @param {{name: string, description?: string}} input */
export const createApplication = (input) => request('POST', '/applications', { body: input });

/**
 * @param {string} applicationId
 * @param {{name?: string, description?: string, autoStart?: boolean}} patch
 */
export const updateApplication = (applicationId, patch) =>
  request('PATCH', appPath(applicationId), { body: patch });

/** @param {string} applicationId */
export const deleteApplication = (applicationId) => request('DELETE', appPath(applicationId));

/** @param {string} applicationId @param {object} input process configuration */
export const addProcess = (applicationId, input) =>
  request('POST', `${appPath(applicationId)}/processes`, { body: input });

/** @param {string} applicationId @param {string} processId @param {object} patch */
export const updateProcess = (applicationId, processId, patch) =>
  request('PATCH', procPath(applicationId, processId), { body: patch });

/** @param {string} applicationId @param {string} processId */
export const removeProcess = (applicationId, processId) =>
  request('DELETE', procPath(applicationId, processId));

/** @param {string} applicationId @param {'start'|'stop'|'restart'} action */
export const applicationAction = (applicationId, action) =>
  request('POST', `${appPath(applicationId)}/${action}`);

/** @param {string} applicationId @param {string} processId @param {'start'|'stop'|'restart'} action */
export const processAction = (applicationId, processId, action) =>
  request('POST', `${procPath(applicationId, processId)}/${action}`);

/**
 * @param {{applicationId: string, processId?: string, limit?: number, sinceSeq?: number,
 *          stream?: 'stdout'|'stderr'}} query
 * @param {AbortSignal} [signal]
 */
export function readLogs(query, signal) {
  const { applicationId, processId, limit, sinceSeq, stream } = query;
  const search = new URLSearchParams();
  if (processId) search.set('processId', processId);
  if (limit != null) search.set('limit', String(limit));
  if (sinceSeq != null) search.set('sinceSeq', String(sinceSeq));
  if (stream) search.set('stream', stream);
  const qs = search.toString();
  return request('GET', `${appPath(applicationId)}/logs${qs ? `?${qs}` : ''}`, { signal });
}

/**
 * The listening-port list. `force` makes the manager rescan the OS instead of answering from its
 * cache — used by the Refresh control, where a stale answer is the whole complaint.
 * @param {{force?: boolean}} [options] @param {AbortSignal} [signal]
 */
export const listPorts = ({ force = false } = {}, signal) =>
  request('GET', `/ports${force ? '?force=1' : ''}`, { signal });

/** @param {number} port */
export const stopPort = (port) => request('POST', `/ports/${port}/stop`);

/**
 * Every cached favicon as a data URL, keyed by process id. Fetched only when the versions carried on
 * the application list change, never on every refetch of that list.
 * @param {AbortSignal} [signal]
 */
export const listFavicons = (signal) => request('GET', '/favicons', { signal });

/** @param {string} applicationId @param {AbortSignal} [signal] */
export const listDatabases = (applicationId, signal) =>
  request('GET', `${appPath(applicationId)}/databases`, { signal });

/**
 * One run of the SQL console. `readOnly` defaults to true on the manager too: a write has to be asked
 * for, and a read-only run takes a single statement.
 * @param {string} applicationId
 * @param {{database: string, sql: string, readOnly: boolean}} input
 */
export const runStatement = (applicationId, input) =>
  request('POST', `${appPath(applicationId)}/sql`, { body: input });

/**
 * PostgreSQL clusters found on this machine — running ones and stopped ones in the usual places —
 * each with the application that already runs it, if any.
 * @param {AbortSignal} [signal]
 */
export const discoverClusters = (signal) => request('GET', '/postgres/discover', { signal });

/** @param {AbortSignal} [signal] */
export const getSettings = (signal) => request('GET', '/settings', { signal });

/**
 * Only the keys sent change. `{startAtLogin: true}` while already on rewrites the login entry, which
 * is how a stale one is repaired.
 * @param {{startAtLogin?: boolean}} patch
 */
export const updateSettings = (patch) => request('PATCH', '/settings', { body: patch });

/**
 * Ask the manager to open the operating system's folder dialog. Resolves when the user has chosen or
 * cancelled — which can be minutes, so there is deliberately no timeout on this side.
 * @param {string} [startAt]
 * @returns {Promise<{status: 'picked', path: string} | {status: 'cancelled'} |
 *                   {status: 'unavailable', reason: string}>}
 */
export const pickDirectory = (startAt = '') => request('POST', '/workspace/pick', { body: { startAt } });

/**
 * The in-page directory browser's one call. An empty path opens at the user's home directory, which is where
 * the picker starts when the form has no path in it yet.
 * @param {string} [directory] @param {AbortSignal} [signal]
 */
export const listDirectory = (directory = '', signal) =>
  request('GET', `/workspace/directory?path=${encodeURIComponent(directory)}`, { signal });

/**
 * What the form can fill in for itself: the package.json scripts and the .env files of the directory
 * the command will run in.
 * @param {string} directory @param {AbortSignal} [signal]
 */
export const inspectDirectory = (directory, signal) =>
  request('GET', `/workspace/inspect?path=${encodeURIComponent(directory)}`, { signal });
