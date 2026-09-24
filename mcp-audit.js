/**
 * The MCP tool-call audit: every call an agent made, which session made it, and how it ended.
 *
 * Same shape as the process logs — a bounded ring in memory for the dashboard, an append-only JSONL
 * file behind it — and for the same reason: the ring answers "what just happened" cheaply, the
 * file keeps the history across a restart. Arguments are stored as the agent sent them except for
 * SQL `params`, whose values can be credentials or personal data and are reduced to their types.
 */
import { appendLine, closeSink, createSink, tailLines } from './jsonl-sink.js';
import { MCP_AUDIT_BUFFER_CALLS, MCP_AUDIT_FILE, MCP_AUDIT_FILE_MAX_BYTES } from './config.js';

/**
 * @typedef {{seq:number, at:string, sessionId:string|null,
 *            client:{name:string, version:string}|null, tool:string, args:object|null,
 *            durationMs:number, ok:boolean, error:string|null}} McpCall
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;
/** Long enough for any real query; short enough that one pasted dump cannot bloat the file. */
const MAX_STRING_CHARS = 4_096;

const sink = createSink(MCP_AUDIT_FILE, MCP_AUDIT_FILE_MAX_BYTES);

/** @type {McpCall[]} oldest first, trimmed from the front */
let calls = [];
let nextSeq = 1;
let hydrated = false;

/**
 * @param {Omit<McpCall, 'seq'|'at'|'args'> & {args?: unknown}} call
 * @returns {McpCall} the stored entry
 */
export function record(call) {
  hydrate();
  const entry = {
    seq: nextSeq++,
    at: new Date().toISOString(),
    sessionId: call.sessionId ?? null,
    client: call.client ?? null,
    tool: call.tool,
    args: redact(call.args),
    durationMs: call.durationMs,
    ok: call.ok,
    error: call.error ?? null,
  };
  store(entry);
  appendLine(sink, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * Most recent calls first, optionally narrowed to one session or one tool.
 * @param {{sessionId?:string, tool?:string, limit?:number}} [q]
 * @returns {McpCall[]}
 */
export function list(q = {}) {
  hydrate();
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const matched = [];
  for (let i = calls.length - 1; i >= 0 && matched.length < limit; i -= 1) {
    const call = calls[i];
    if (q.sessionId && call.sessionId !== q.sessionId) continue;
    if (q.tool && call.tool !== q.tool) continue;
    matched.push(call);
  }
  return matched;
}

/** Flush queued writes; awaited on shutdown. */
export const close = () => closeSink(sink);

function store(entry) {
  calls.push(entry);
  const capacity = Math.max(1, Math.trunc(MCP_AUDIT_BUFFER_CALLS));
  if (calls.length > capacity) calls = calls.slice(-capacity);
}

/** First touch after a restart: the ring is empty, but the file still holds the history. */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  for (const line of tailLines(MCP_AUDIT_FILE, MCP_AUDIT_BUFFER_CALLS)) {
    const entry = parseStored(line);
    if (entry) store(entry);
  }
}

/** Renumbered like the process logs: seq is this run's ordering, not a stored identity. */
function parseStored(line) {
  try {
    const entry = JSON.parse(line);
    if (typeof entry?.tool !== 'string') return null;
    return { ...entry, seq: nextSeq++ };
  } catch {
    return null;
  }
}

/** @param {unknown} args */
function redact(args) {
  if (!args || typeof args !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = key === 'params' && Array.isArray(value) ? value.map(typeOf) : clip(value);
  }
  return out;
}

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

const clip = (value) =>
  typeof value === 'string' && value.length > MAX_STRING_CHARS
    ? `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more chars]`
    : value;
