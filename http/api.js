/**
 * The REST surface. It owns no domain logic at all: every route is a thin translation between an
 * HTTP request and one `service.js` call, which is also what the MCP tools call — so the two
 * front-ends can never drift apart.
 *
 * Matching is a flat table of split paths with `:param` segments. A path has at most five segments,
 * so a linear scan is faster to read than any regex and needs no router dependency.
 *
 * `/api/events` is not in this table: SSE owns its response for the life of the connection, so
 * `server.js` routes it straight to `http/events.js` before the request reaches here.
 */
import { json, noContent, readJsonBody, httpErrorStatus, badRequest } from './respond.js';
import * as service from '../service.js';

const route = (method, pattern, handler) => ({
  method,
  pattern: pattern.split('/').filter(Boolean),
  handler,
});

const routes = [
  route('GET', '/api/health', () => ({
    status: 'ok',
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1_000),
  })),

  route('GET', '/api/applications', () => service.listApplications()),
  route('POST', '/api/applications', async ({ req }) =>
    service.createApplication(await readJsonBody(req))),
  route('GET', '/api/applications/:appId', ({ params }) => service.getApplication(params.appId)),
  route('PATCH', '/api/applications/:appId', async ({ params, req }) =>
    service.updateApplication(params.appId, await readJsonBody(req))),
  route('DELETE', '/api/applications/:appId', async ({ params }) => {
    await service.deleteApplication(params.appId);
  }),

  route('POST', '/api/applications/:appId/start', ({ params }) =>
    service.startApplication(params.appId)),
  route('POST', '/api/applications/:appId/stop', ({ params }) =>
    service.stopApplication(params.appId)),
  route('POST', '/api/applications/:appId/restart', ({ params }) =>
    service.restartApplication(params.appId)),

  route('POST', '/api/applications/:appId/processes', async ({ params, req }) =>
    service.addProcess(params.appId, await readJsonBody(req))),
  route('PATCH', '/api/applications/:appId/processes/:procId', async ({ params, req }) =>
    service.updateProcess(params.appId, params.procId, await readJsonBody(req))),
  route('DELETE', '/api/applications/:appId/processes/:procId', async ({ params }) => {
    await service.removeProcess(params.appId, params.procId);
  }),

  route('POST', '/api/applications/:appId/processes/:procId/start', ({ params }) =>
    service.startProcess(params.appId, params.procId)),
  route('POST', '/api/applications/:appId/processes/:procId/stop', ({ params }) =>
    service.stopProcess(params.appId, params.procId)),
  route('POST', '/api/applications/:appId/processes/:procId/restart', ({ params }) =>
    service.restartProcess(params.appId, params.procId)),

  route('GET', '/api/applications/:appId/logs', ({ params, url }) =>
    service.readLogs(logQuery(params.appId, url))),

  // POST, not GET: it puts a dialog on the user's screen, and a GET is something a browser may send
  // on its own (a prefetch, a restored tab).
  route('POST', '/api/workspace/pick', async ({ req }) =>
    service.pickDirectory((await readJsonBody(req)).startAt)),
  route('GET', '/api/workspace/directory', ({ url }) => service.listDirectory(pathQuery(url))),
  route('GET', '/api/workspace/inspect', ({ url }) => service.inspectDirectory(pathQuery(url))),

  route('GET', '/api/favicons', () => service.listFavicons()),

  route('GET', '/api/ports', ({ url }) =>
    service.listPorts({ force: url.searchParams.get('force') === '1' })),
  route('GET', '/api/ports/:port', ({ params }) => service.getPort(portParam(params.port))),
  route('POST', '/api/ports/:port/stop', ({ params }) => service.stopPort(portParam(params.port))),
];

/**
 * Both workspace routes address a directory by query parameter rather than by path segment: an
 * absolute path contains separators, and a path segment is exactly the thing that cannot hold them.
 * An absent parameter stays absent — `listDirectory` reads that as "open at home", and `inspect`
 * rejects it, and neither decision belongs up here.
 */
const pathQuery = (url) => url.searchParams.get('path') ?? '';

/**
 * A port arrives as a path segment, so it is a string until proven otherwise. It is parsed here
 * rather than in the service so that `/api/ports/abc` is a 400 about the URL, not a domain error.
 */
function portParam(value) {
  const port = Number(value);
  if (!Number.isInteger(port)) throw badRequest(`"${value}" is not a port number`);
  return port;
}

/** @returns {Record<string,string>|null} the captured params, or null when the shape differs */
function matchPattern(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part.startsWith(':')) {
      params[part.slice(1)] = segments[i];
      continue;
    }
    if (part !== segments[i]) return null;
  }
  return params;
}

function findRoute(method, segments) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const params = matchPattern(candidate.pattern, segments);
    if (params) return { handler: candidate.handler, params };
  }
  return null;
}

/**
 * An absent or empty query parameter means "not supplied" — never 0. `Number('')` is 0, which would
 * turn a fresh client's missing cursor into a request for the whole buffer (FINDINGS K2). A
 * negative or fractional value is rejected here rather than reaching the ring buffer, where a
 * negative `sinceSeq` reads as a stale cursor and reports a gap that never happened.
 */
const numberParam = (url, name) => {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest(`Query parameter "${name}" must be a non-negative integer`);
  }
  return value;
};

const streamParam = (url) => {
  const stream = url.searchParams.get('stream');
  if (!stream) return undefined;
  if (stream !== 'stdout' && stream !== 'stderr') {
    throw badRequest('Query parameter "stream" must be "stdout" or "stderr"');
  }
  return stream;
};

const logQuery = (applicationId, url) => ({
  applicationId,
  processId: url.searchParams.get('processId') || undefined,
  limit: numberParam(url, 'limit'),
  sinceSeq: numberParam(url, 'sinceSeq'),
  stream: streamParam(url),
});

const CODE_BY_STATUS = { 400: 'validation_error', 404: 'not_found', 500: 'internal_error' };

/**
 * The code is derived from the status, never from `err.code`: a failure below us carries an errno
 * (`ENOENT`, `ECONNRESET`), and handing that to the UI as the API's error code would make the
 * enumeration unbranchable.
 */
function sendError(res, status, err) {
  // The client vanished mid-request, or we already committed headers — there is nothing to answer
  // into, and writing to a destroyed response raises an unhandled stream error.
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  // A 500 is our bug, not the caller's: the client gets a message, we keep the stack.
  if (status >= 500) console.error('[paddock] api request failed:', err);
  json(res, status, {
    error: {
      message: err?.message ?? 'Internal error',
      code: CODE_BY_STATUS[status] ?? 'internal_error',
    },
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} true when the request was handled
 */
export async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return false;

  const match = findRoute(req.method, segments);
  if (!match) {
    sendError(res, 404, new Error(`No API route for ${req.method} ${url.pathname}`));
    return true;
  }

  try {
    const body = await match.handler({ params: match.params, req, url });
    if (body === undefined) noContent(res);
    else json(res, 200, body);
  } catch (err) {
    sendError(res, httpErrorStatus(err), err);
  }
  return true;
}
