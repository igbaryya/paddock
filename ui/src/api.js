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
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
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

/** @param {{name: string, description?: string, kind?: 'processes'|'postgres'}} input */
export const createApplication = (input) => request('POST', '/applications', { body: input });

/**
 * @param {string} applicationId
 * @param {{name?: string, description?: string, autoStart?: boolean, postgres?: object}} patch
 *   `postgres` defines a PostgreSQL application's server the first time, and edits it after
 */
export const updateApplication = (applicationId, patch) =>
  request('PATCH', appPath(applicationId), { body: patch });

/** @param {string} applicationId */
export const deleteApplication = (applicationId) => request('DELETE', appPath(applicationId));

/**
 * Where the canvas has left the application's cards. Sent whole on every drop — the manager stores
 * exactly the positions of the cards being shown — and answers with the layout, not an application
 * view: moving a card changes nothing about what is running.
 * @param {string} applicationId
 * @param {Record<string, {x: number, y: number}>} layout keyed by node id
 */
export const saveLayout = (applicationId, layout) =>
  request('PUT', `${appPath(applicationId)}/layout`, { body: { layout } });

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
 * A process's repository, read-only: what is changed, one file's diff, and the history behind it.
 * All three say `{repo: false}` / fail with the manager's own words when the directory is not one.
 * @param {string} applicationId @param {string} processId @param {AbortSignal} [signal]
 */
export const getGitStatus = (applicationId, processId, signal) =>
  request('GET', `${procPath(applicationId, processId)}/git`, { signal });

/**
 * @param {string} applicationId @param {string} processId
 * @param {{path: string, staged?: boolean, untracked?: boolean}} file @param {AbortSignal} [signal]
 */
export function getGitDiff(applicationId, processId, file, signal) {
  const search = new URLSearchParams({ path: file.path });
  if (file.staged) search.set('staged', '1');
  if (file.untracked) search.set('untracked', '1');
  return request('GET', `${procPath(applicationId, processId)}/git/diff?${search}`, { signal });
}

/** @param {string} applicationId @param {string} processId @param {AbortSignal} [signal] */
export const getGitLog = (applicationId, processId, signal) =>
  request('GET', `${procPath(applicationId, processId)}/git/log`, { signal });

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
 * One reading of the machine's CPU, memory and disk — the meters' first fill. Every later reading
 * arrives as a `system` event on the stream.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{sampledAt: string, intervalMs: number,
 *   cpu: {percent: number|null, cores: number, loadAverage: number[]|null},
 *   memory: {total: number, used: number, percent: number}|null,
 *   disk: {path: string, total: number, used: number, free: number, percent: number}|null}>}
 */
export const getSystemStats = (signal) => request('GET', '/system', { signal });

/**
 * The machine's private and public addresses, and every interface's. `force` asks the manager to
 * look the public address up again rather than answer from its cache. A change after this arrives
 * as a `network` event on the stream.
 * @param {{force?: boolean}} [options] @param {AbortSignal} [signal]
 * @returns {Promise<{readAt: string, hostname: string,
 *   privateIp: {address: string, interface: string|null}|null,
 *   publicIp: {address: string|null, checkedAt: string}|null,
 *   interfaces: {name: string, mac: string|null, primary: boolean,
 *     addresses: {family: string, address: string, cidr: string|null}[]}[]}>}
 */
export const getNetwork = ({ force = false } = {}, signal) =>
  request('GET', `/network${force ? '?force=1' : ''}`, { signal });

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
 * Whether the setup wizard opens by itself — a fresh install only — and when it was last finished.
 * @param {AbortSignal} [signal] @returns {Promise<{completedAt: string|null, needed: boolean}>}
 */
export const getSetup = (signal) => request('GET', '/setup', { signal });

/** Finished or skipped: either way it does not open by itself again. */
export const completeSetup = () => request('POST', '/setup/complete');

/**
 * Paddock's mark: the user's image as a data URL, or null for Paddock's own.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{logo: {dataUrl: string, contentType: string, bytes: number, updatedAt: string}|null}>}
 */
export const getBranding = (signal) => request('GET', '/branding', { signal });

/** @param {string} dataUrl a base64 data URL; the manager reads the type from the bytes, not the label */
export const setLogo = (dataUrl) => request('PUT', '/branding/logo', { body: { dataUrl } });

export const resetLogo = () => request('DELETE', '/branding/logo');

/** @param {AbortSignal} [signal] */
export const getMcp = (signal) => request('GET', '/mcp', { signal });

/** @param {{port: number}} input */
export const configureMcp = (input) => request('POST', '/mcp/configure', { body: input });

/** @param {{port?: number, enabled?: boolean}} patch */
export const updateMcp = (patch) => request('PATCH', '/mcp', { body: patch });

export const startMcp = () => request('POST', '/mcp/start');
export const stopMcp = () => request('POST', '/mcp/stop');
export const restartMcp = () => request('POST', '/mcp/restart');

/**
 * Cursor and Claude Code: whether each is installed, whether its MCP settings reach this Paddock, and
 * which one to suggest. @param {AbortSignal} [signal]
 * @returns {Promise<{clients: {id: string, name: string, detected: boolean, suggested: boolean,
 *   state: 'missing'|'configured'|'stale'|'unreadable', displayPath: string,
 *   configuredUrl: string|null, error: string|null}[]}>}
 */
export const listMcpClients = (signal) => request('GET', '/mcp/clients', { signal });

/** Write Paddock's entry into that client's MCP settings. @param {string} clientId */
export const installMcpClient = (clientId) =>
  request('POST', `/mcp/clients/${encodeURIComponent(clientId)}`);

/** Agents connected over MCP right now, most recently seen first. @param {AbortSignal} [signal] */
export const listMcpSessions = (signal) => request('GET', '/mcp/sessions', { signal });

/**
 * The tool calls agents made, newest first. The audit keeps arguments with SQL parameter values
 * reduced to their types.
 * @param {{sessionId?: string, tool?: string, limit?: number}} [query] @param {AbortSignal} [signal]
 */
export function listMcpCalls(query = {}, signal) {
  const search = new URLSearchParams();
  if (query.sessionId) search.set('sessionId', query.sessionId);
  if (query.tool) search.set('tool', query.tool);
  if (query.limit != null) search.set('limit', String(query.limit));
  const qs = search.toString();
  return request('GET', `/mcp/calls${qs ? `?${qs}` : ''}`, { signal });
}

/**
 * Whether this installation can open a terminal, where one may be opened for this application, and
 * which of them are already open.
 * @param {string} applicationId @param {AbortSignal} [signal]
 * @returns {Promise<{support: {available: boolean, reason: string|null},
 *                    targets: {processId: string, processName: string, cwd: string}[],
 *                    sessions: object[]}>}
 */
export const listTerminals = (applicationId, signal) =>
  request('GET', `${appPath(applicationId)}/terminals`, { signal });

/**
 * Open a shell. `processId` names one of the targets above, never a path — where that process runs
 * is the manager's to resolve, and a browser has no business naming a directory on this machine.
 * @param {string} applicationId
 * @param {{processId?: string, cols?: number, rows?: number}} input
 */
export const openTerminal = (applicationId, input) =>
  request('POST', `${appPath(applicationId)}/terminals`, { body: input });

const terminalPath = (sessionId) => `/terminals/${encodeURIComponent(sessionId)}`;

/**
 * Keystrokes, verbatim and unbatched. One request per keypress is affordable only because this is
 * loopback: the alternative is a socket, and a socket would need a second copy of the origin guard.
 * @param {string} sessionId @param {string} data
 */
export const writeTerminal = (sessionId, data) =>
  request('POST', `${terminalPath(sessionId)}/input`, { body: { data } });

/** @param {string} sessionId @param {number} cols @param {number} rows */
export const resizeTerminal = (sessionId, cols, rows) =>
  request('POST', `${terminalPath(sessionId)}/resize`, { body: { cols, rows } });

/** @param {string} sessionId */
export const closeTerminal = (sessionId) => request('DELETE', terminalPath(sessionId));

/**
 * Where a terminal's output is followed. An `EventSource` rather than a fetch: the session outlives
 * the page, so reconnecting to one is normal and the stream replays what was missed.
 * @param {string} sessionId
 */
export const terminalStreamUrl = (sessionId) => `${API}${terminalPath(sessionId)}/stream`;

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
