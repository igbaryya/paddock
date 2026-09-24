/**
 * The SSE hub: one subscription to the service event emitter, fanned out to every open dashboard.
 *
 * The transport — headers, framing, dropping a stalled reader, the shared keep-alive — is
 * `sse.js`, and is the same one a terminal's output streams over. What is left here is the part
 * that is the hub's own: a dev server can emit thousands of lines a second, so log events are
 * coalesced into ~50 ms batches instead of one frame per line, and every frame goes to every open
 * dashboard rather than to one client.
 *
 * Payloads, as the UI must read them:
 *   `status`        `{applicationId, processId, state}` — forwarded verbatim
 *   `log`           an ARRAY of `{applicationId, processId, entry}`, because of the batching above;
 *                   `entry` is `{seq, ts, stream, message}`
 *   `applications`  config changed; the UI refetches, the payload carries nothing it needs
 *   `ports`         `{scannedAt, ports, degraded}` — pushed only when the port list actually
 *                   changes, from one server-side scan shared by every client
 *   `mcp`           `{kind: 'sessions', sessions}` when an agent connects, identifies itself or
 *                   leaves, and `{kind: 'call', call}` for every tool call an agent makes
 */
import { events as serviceEvents } from '../service.js';
import * as service from '../service.js';
import * as sse from './sse.js';
import { PORT_SCAN_INTERVAL_MS } from '../config.js';

const LOG_BATCH_MS = 50;
const MAX_BATCH_ENTRIES = 500;

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

let started = false;
let logTimer = null;
let portTimer = null;
let lastPortFingerprint = null;
let pendingLogs = [];

function broadcast(type, payload) {
  const chunk = sse.frame(type, payload);
  for (const res of clients) sse.write(res, chunk);
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

const onMcp = (event) => {
  if (clients.size) broadcast('mcp', event);
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
  if (sse.rejectNonGet(req, res)) return;
  clients.add(res);
  sse.open(res, () => clients.delete(res));
}

/** Subscribe to the service emitter and start the port scan. */
export function start() {
  if (started) return;
  started = true;
  serviceEvents.on('status', onStatus);
  serviceEvents.on('log', onLog);
  serviceEvents.on('applications', onApplications);
  serviceEvents.on('mcp', onMcp);
  // 0 turns background scanning off entirely; the ports view then updates only when asked.
  if (PORT_SCAN_INTERVAL_MS > 0) {
    portTimer = setInterval(scanPorts, PORT_SCAN_INTERVAL_MS);
    portTimer.unref();
  }
}

/** Unsubscribe, cancel the timers, and close every stream cleanly for shutdown. */
export function stop() {
  started = false;
  serviceEvents.off('status', onStatus);
  serviceEvents.off('log', onLog);
  serviceEvents.off('applications', onApplications);
  serviceEvents.off('mcp', onMcp);

  clearInterval(portTimer);
  portTimer = null;
  lastPortFingerprint = null;
  clearTimeout(logTimer);
  logTimer = null;
  pendingLogs = [];

  for (const res of [...clients]) sse.end(res);
  clients.clear();
}
