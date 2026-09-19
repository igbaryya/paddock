/**
 * The server-sent-events transport, with no opinion about what is being streamed.
 *
 * Two things stream over SSE — the dashboard-wide hub in `events.js` and one terminal's output in
 * `terminal-stream.js` — and everything about *how* they stream is identical: the same headers, the
 * same framing, the same reason a stalled reader has to be dropped, and the same keep-alive. Only
 * what they send differs, and that is all their own modules do.
 *
 * Wire format: `event: <type>` + a single JSON `data:` line + a blank line. The payload is always
 * `JSON.stringify`d, and that is what guarantees a newline in the data — a multi-line log message,
 * a terminal printing anything at all — cannot break framing.
 */

const PING_INTERVAL_MS = 25_000;

/**
 * A client that stops reading buffers without limit in the kernel and in `res.writableLength`, so
 * it is dropped rather than allowed to grow the heap overnight.
 */
const MAX_BUFFERED_BYTES = 1_048_576;

const HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Every open stream, whatever it carries, mapped to what it is holding open. One registry for one
 * shared ping timer: a timer per client would be a timer per open dashboard tab.
 * @type {Map<import('node:http').ServerResponse, (() => void)|undefined>}
 */
const clients = new Map();

let pingTimer = null;

/**
 * Forget a stream and release what it held, exactly once. Every way a stream can finish goes
 * through here: a disconnect, an error, a drop for backpressure, and a deliberate end — and
 * several of them fire for the same disconnect.
 * @returns {boolean} true when this call is the one that finished it
 */
function release(res) {
  if (!clients.has(res)) return false;
  const onClose = clients.get(res);
  clients.delete(res);
  onClose?.();
  return true;
}

/** @param {string} type @param {unknown} payload */
export const frame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * Must never hold the manager open: a dashboard left in a background tab would otherwise keep the
 * process alive for as long as the browser does.
 */
function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const res of clients.keys()) write(res, ': ping\n\n');
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();
}

/**
 * Begin a stream. The comment frame flushes the headers, so `EventSource` fires `onopen` without
 * waiting for the first real event.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {() => void} [onClose] run once, whether the client disconnected, the response errored or
 *   we dropped it for not reading — callers use it to release whatever the stream was holding
 */
export function open(res, onClose) {
  res.writeHead(200, HEADERS);
  clients.set(res, onClose);
  // 'close' fires for both a disconnect and a normal end, and 'error' can fire alongside it.
  const drop = () => {
    if (release(res)) res.destroy();
  };
  res.on('close', drop);
  res.on('error', drop);
  startPing();
  write(res, ': connected\n\n');
}

/**
 * Write a raw chunk to one stream, dropping it if it has stopped reading.
 * @param {import('node:http').ServerResponse} res
 * @param {string} chunk
 */
export function write(res, chunk) {
  if (!clients.has(res)) return;
  if (res.writableEnded || res.destroyed || res.writableLength > MAX_BUFFERED_BYTES) {
    if (release(res)) res.destroy();
    return;
  }
  res.write(chunk);
}

/** @param {import('node:http').ServerResponse} res @param {string} type @param {unknown} payload */
export const send = (res, type, payload) => write(res, frame(type, payload));

/**
 * End one stream cleanly, flushing what is buffered — as opposed to a drop, which destroys it.
 * @param {import('node:http').ServerResponse} res
 */
export function end(res) {
  if (release(res)) res.end();
}

/** @param {import('node:http').IncomingMessage} req @returns {boolean} true when it was answered */
export function rejectNonGet(req, res) {
  if (req.method === 'GET') return false;
  res.writeHead(405, { Allow: 'GET', 'Content-Length': 0 });
  res.end();
  return true;
}

/** For shutdown, once every stream's own module has closed what it was holding. */
export function stop() {
  clearInterval(pingTimer);
  pingTimer = null;
}
