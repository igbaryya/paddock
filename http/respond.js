/**
 * Tiny request/response helpers shared by the HTTP layer. Every JSON body and every error envelope
 * is built here so the REST routes never hand-roll one and the UI has a single error shape to read.
 * The domain error classes live below `http/`, which may not import them, so the status mapping
 * matches on the class name instead of on identity.
 */

/** @param {unknown} err @param {string} name */
const isNamed = (err, name) => err?.name === name || err?.constructor?.name === name;

/**
 * A 400-mapped error raised by the HTTP layer itself (malformed body, bad query parameter).
 * It carries the domain name so `httpErrorStatus` treats it exactly like a `ValidationError`.
 * @param {string} message
 */
export const badRequest = (message) =>
  Object.assign(new Error(message), { name: 'ValidationError' });

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

/** @param {import('node:http').ServerResponse} res */
export const noContent = (res) => {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
};

/**
 * Read and parse a JSON request body, bounded so a runaway client cannot buffer the manager to
 * death. An empty body is an empty patch, not a parse error — `POST .../start` sends nothing.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes]
 * @returns {Promise<object>}
 */
export async function readJsonBody(req, limitBytes = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Breaking out of the iteration destroys the request, so the client stops sending.
    if (size > limitBytes) throw badRequest(`Request body exceeds ${limitBytes} bytes`);
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object');
  }
  return parsed;
}

/**
 * Map a thrown domain error onto a status code. Anything unrecognised is a bug in us, not in the
 * caller, so it is a 500.
 * @param {unknown} err
 * @returns {number}
 */
export function httpErrorStatus(err) {
  if (isNamed(err, 'ValidationError')) return 400;
  if (isNamed(err, 'NotFoundError')) return 404;
  return 500;
}
