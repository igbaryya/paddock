/**
 * The SSE hub: one subscription to the service event emitter, fanned out to every open dashboard.
 *
 * Shaped by three constraints. The manager must still be able to exit, so there is exactly one
 * shared `.unref()`'d ping timer for the whole hub rather than one per client. A dev server can
 * emit thousands of lines a second, so log events are coalesced into ~50 ms batches instead of one
 * frame per line. And a client that stops reading buffers without limit in the kernel and in
 * `res.writableLength`, so it is dropped rather than allowed to grow the heap overnight.
 *
 * Wire format: `event: <type>` + a single JSON `data:` line + a blank line. The payload is always
 * `JSON.stringify`d, which is what guarantees multi-line log text cannot break framing.
 *
 * Payloads, as the UI must read them:
 *   `status`        `{applicationId, processId, state}` — forwarded verbatim
 *   `log`           an ARRAY of `{applicationId, processId, entry}`, because of the batching above;
 *                   `entry` is `{seq, ts, stream, message}`
 *   `applications`  config changed; the UI refetches, the payload carries nothing it needs
 *   `ports`         `{scannedAt, ports, degraded}` — pushed only when the port list actually
 *                   changes, from one server-side scan shared by every client
 */
import { events as serviceEvents } from '../service.js';
import * as service from '../service.js';
import { PORT_SCAN_INTERVAL_MS } from '../config.js';

const PING_INTERVAL_MS = 25_000;
const LOG_BATCH_MS = 50;
const MAX_BATCH_ENTRIES = 500;
const MAX_BUFFERED_BYTES = 1_048_576;

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

let pingTimer = null;
let logTimer = null;
let portTimer = null;
let lastPortFingerprint = null;
let pendingLogs = [];

const frame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

/** 'close' fires for both a disconnect and a normal end, and 'error' can fire alongside it. */
function remove(res) {
  if (!clients.delete(res)) return;
  res.destroy();
}

/** A stalled reader shows up as a growing write buffer; drop it before it becomes a leak. */
function write(res, chunk) {
  if (res.writableEnded || res.destroyed) {
    remove(res);
    return;
  }
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    remove(res);
    return;
  }
  res.write(chunk);
}

function broadcast(type, payload) {
  const chunk = frame(type, payload);
  for (const res of clients) write(res, chunk);
}

function flushLogs() {
  if (logTimer) {
    clearTimeout(logTimer);
    logTimer = null;
  }
  if (!pendingLogs.length) return;
  const batch = pendingLogs;
  pendingLogs = [];
  broadcast('log', batch);
}

/** process-manager emits a LogEntry flattened with its ids; the wire nests it back. */
const toLogPayload = ({ applicationId, processId, ...entry }) => ({
  applicationId,
  processId,
  entry,
});

/** Batched: the payload is an array of `{applicationId, processId, entry}`. */
function onLog(event) {
  if (!clients.size) return;
  pendingLogs.push(toLogPayload(event));
  if (pendingLogs.length >= MAX_BATCH_ENTRIES) {
    flushLogs();
    return;
  }
  if (logTimer) return;
  logTimer = setTimeout(flushLogs, LOG_BATCH_MS);
  logTimer.unref();
}

/** Flush first, so the lines that explain a crash reach the UI before the crash status does. */
function onStatus(event) {
  if (!clients.size) return;
  flushLogs();
  broadcast('status', event);
}

const onApplications = (event) => {
  if (clients.size) broadcast('applications', event ?? {});
};

const ping = () => {
  for (const res of clients) write(res, ': ping\n\n');
};

/**
 * Port state changes without anything telling us, so it is the one thing here that has to be
 * polled. It is polled ONCE on the server, gated on someone actually watching, rather than by each
 * open dashboard: client-side polling would multiply the OS scan by the number of tabs and would
 * keep scanning for a tab nobody has looked at in hours.
 */
async function scanPorts() {
  if (!clients.size) return;
  try {
    const { scannedAt, ports, degraded } = await service.listPorts();
    const fingerprint = JSON.stringify(ports.map((p) => [p.port, p.pid, p.owner.kind]));
    // Only on change: a dev machine's port list is static for minutes at a time, and a message per
    // tick would be noise the UI has to diff anyway.
    if (fingerprint === lastPortFingerprint) return;
    lastPortFingerprint = fingerprint;
    broadcast('ports', { scannedAt, ports, degraded });
  } catch (err) {
    // A scan that fails leaves the previous list on screen; saying nothing is better than blanking
    // the table over one transient failure of an OS utility.
    console.error('[paddock] port scan failed:', err.message);
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleEvents(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', 'Content-Length': 0 });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  clients.add(res);
  res.on('close', () => remove(res));
  res.on('error', () => remove(res));

  // A comment frame flushes the headers so EventSource fires `onopen` without waiting for traffic.
  write(res, ': connected\n\n');
}

/** Subscribe to the service emitter and start the single shared keep-alive timer. */
export function start() {
  if (pingTimer) return;
  serviceEvents.on('status', onStatus);
  serviceEvents.on('log', onLog);
  serviceEvents.on('applications', onApplications);
  pingTimer = setInterval(ping, PING_INTERVAL_MS);
  pingTimer.unref();
  // 0 turns background scanning off entirely; the ports view then updates only when asked.
  if (PORT_SCAN_INTERVAL_MS > 0) {
    portTimer = setInterval(scanPorts, PORT_SCAN_INTERVAL_MS);
    portTimer.unref();
  }
}

/** Unsubscribe, cancel both timers, and close every stream cleanly for shutdown. */
export function stop() {
  serviceEvents.off('status', onStatus);
  serviceEvents.off('log', onLog);
  serviceEvents.off('applications', onApplications);

  clearInterval(pingTimer);
  pingTimer = null;
  clearInterval(portTimer);
  portTimer = null;
  lastPortFingerprint = null;
  clearTimeout(logTimer);
  logTimer = null;
  pendingLogs = [];

  for (const res of clients) res.end();
  clients.clear();
}
