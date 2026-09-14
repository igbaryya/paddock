/**
 * Entry point: the HTTP server, the route table, and the shutdown path.
 *
 * Two things live here and nowhere else. The local-origin guard is a security control, so there is
 * exactly one copy of it — applied to /api and /mcp, with nothing below this file re-deciding who is
 * allowed in. And the signal handling is all that stands between a Ctrl-C and a terminal full of
 * orphaned dev servers: a lone 'exit' handler never runs when a signal terminates the process, and
 * anything asynchronous inside one is discarded, so the graceful stop happens in the signal handler
 * and 'exit' only gets a synchronous last-resort kill.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { HOST, PORT, STOP_GRACE_MS } from './config.js';
import { json } from './http/respond.js';
import { handleApi } from './http/api.js';
import { handleEvents, start as startEvents, stop as stopEvents } from './http/events.js';
import { handleMcp } from './http/mcp.js';
import { handleStatic } from './http/static.js';
import { loginShellPath } from './platform/index.js';
import { reapOrphans, killAllSync } from './process-manager.js';
import { autoStartApplications, loadFavicons, shutdown as shutdownService } from './service.js';

/** Bounded because it costs a login shell startup (~0.5 s) and is only a best-effort improvement. */
const PATH_RESOLVE_TIMEOUT_MS = 3_000;

/**
 * Ceiling on the graceful stop, so one wedged process group cannot hang the manager's exit. Derived
 * from the per-process grace rather than fixed: a user who raises STOP_GRACE_MS is asking for a
 * longer SIGTERM window, and a constant ceiling would cut the SIGKILL escalation off before it ran.
 */
const SHUTDOWN_GRACE_MS = Math.max(15_000, STOP_GRACE_MS + 5_000);

/** An IPv6 literal only compares equal to a parsed Host header in its bracketed form. */
const configuredHostname = HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', configuredHostname]);

/** A wildcard bind is not an address the user can open; point them at loopback instead. */
const displayHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : configuredHostname;

/**
 * For the last thing printed before `process.exit`. Node's stderr is asynchronous when it is a pipe
 * — which is exactly how `npm run dev` runs us — and exiting discards whatever is still queued, so
 * the one message explaining why we are exiting is the one that would be lost.
 * @param {string} message
 */
const logSync = (message) => {
  try {
    fs.writeSync(2, `[paddock] ${message}\n`);
  } catch {
    // A closed or full stderr must not become the reason we fail to exit.
  }
};

/** @param {string} [value] an absolute URL — a Host header must be given a scheme first */
const hostnameOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

/** Covers all of 127/8 and the IPv4-mapped form a dual-stack socket reports. */
const isLoopbackAddress = (address = '') => {
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return addr === '::1' || addr.startsWith('127.');
};

const isGuardedPath = (pathname) =>
  pathname === '/mcp' || pathname === '/api' || pathname.startsWith('/api/');

/**
 * Only the path and the query are ever read downstream, so the base is a constant: parsing against
 * the Host header would let a hostile one throw out of the router before the guard below runs.
 * @param {import('http').IncomingMessage} req
 */
const parseTarget = (req) => {
  try {
    return new URL(req.url, 'http://localhost');
  } catch {
    return null;
  }
};

/**
 * The one copy of the local-origin check. Deliberately port-agnostic: the Vite dev server proxies
 * from another port, and a page already served from loopback is not the threat — a page on a remote
 * origin driving the process manager is, and that is what this blocks.
 * @param {import('http').IncomingMessage} req
 */
function isLocalRequest(req) {
  // Checked first because it is the one layer a client cannot forge with a header.
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (!req.headers.host) return false;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(`http://${req.headers.host}`))) return false;
  const origin = req.headers.origin;
  // An absent Origin is a non-browser client (an MCP agent); only a present foreign one is a threat.
  return !origin || LOCAL_HOSTNAMES.has(hostnameOf(origin));
}

let markReady;

/**
 * Settles once startup has finished reaping. The port is bound before that (see `main`), so a request
 * can arrive while the reaper is still reading runtime.json — and one that starts a process then would
 * write a record the reaper could validate and kill. Every request waits here instead; at startup that
 * is milliseconds, and afterwards it is an already-settled promise.
 */
const ready = new Promise((resolve) => {
  markReady = resolve;
});

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
async function route(req, res) {
  await ready;
  const url = parseTarget(req);
  if (!url) {
    return json(res, 400, { error: { message: 'malformed request target', code: 'bad_request' } });
  }
  const { pathname } = url;
  if (isGuardedPath(pathname) && !isLocalRequest(req)) {
    return json(res, 403, { error: { message: 'local requests only', code: 'forbidden' } });
  }
  if (pathname === '/mcp') return handleMcp(req, res);
  if (pathname === '/api/events') return handleEvents(req, res);
  if (isGuardedPath(pathname)) {
    if (await handleApi(req, res, url)) return;
    const message = `no route for ${req.method} ${pathname}`;
    return json(res, 404, { error: { message, code: 'not_found' } });
  }
  if (await handleStatic(req, res, url)) return;
  json(res, 404, { error: { message: `not found: ${pathname}`, code: 'not_found' } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`[paddock] ${req.method} ${req.url} failed:`, err.message);
    if (res.headersSent) return res.destroy();
    json(res, 500, { error: { message: err.message, code: 'internal_error' } });
  });
});

server.on('error', (err) => {
  const detail = err.code === 'EADDRINUSE' ? `${displayHost}:${PORT} is already in use` : err.message;
  logSync(`cannot serve: ${detail}`);
  process.exit(1);
});

/**
 * A manager launched from Finder, the Dock or launchd inherits a minimal PATH with no nvm and no
 * homebrew, and then every `npm run dev` it spawns fails. Append what the login shell knows and the
 * inherited PATH lacks — additive only, because a terminal's PATH is often the richer of the two.
 */
async function mergeLoginShellPath() {
  const resolved = await loginShellPath(PATH_RESOLVE_TIMEOUT_MS).catch(() => null);
  if (!resolved) return;
  const inherited = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const known = new Set(inherited);
  const added = resolved.split(path.delimiter).filter((entry) => entry && !known.has(entry));
  if (!added.length) return;
  process.env.PATH = [...inherited, ...added].join(path.delimiter);
  console.error(`[paddock] PATH: appended ${added.length} entries from the login shell`);
}

let shuttingDown = false;

/**
 * The graceful phase: stop accepting work, stop every managed process group, then exit — which is
 * what runs the synchronous last-resort kill below. Bounded, and a repeat signal short-circuits it
 * rather than being swallowed — a user who gets no response presses Ctrl-C again.
 * @param {string} signal
 */
async function shutdown(signal) {
  // A second Ctrl-C is the user saying they will not wait: exit now and let the 'exit' handler below
  // SIGKILL every group synchronously. Impatience must never be a way to orphan a dev server.
  if (shuttingDown) {
    logSync(`${signal} again — exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  console.error(`[paddock] ${signal} — stopping managed processes`);
  server.close();
  stopEvents();
  let deadline;
  const bounded = new Promise((resolve) => {
    deadline = setTimeout(() => resolve('timed out'), SHUTDOWN_GRACE_MS);
  });
  // The handlers go on the inner promise, not the race: a rejection arriving after the timeout has
  // already won would otherwise have nothing attached to it.
  const graceful = shutdownService().then(() => 'done', (err) => `failed: ${err.message}`);
  const outcome = await Promise.race([graceful, bounded]);
  // A pending timer is dropped by process.exit anyway; clearing it is how the exit stays predictable.
  clearTimeout(deadline);
  if (outcome !== 'done') logSync(`graceful stop ${outcome} — killing what is left`);
  process.exit(0);
}

/** Resolves once the port is ours; a taken port never resolves, because `server.on('error')` exits. */
const listen = () => new Promise((resolve) => server.listen(PORT, HOST, resolve));

async function main() {
  await mergeLoginShellPath();
  // The port is bound BEFORE reaping, and that order is the whole point. runtime.json is shared by
  // every Paddock on this data directory, and the reaper treats each record in it as a run that is
  // over. A second copy started while one is already running — `npm start` out of habit with the
  // login agent up — would otherwise kill every service the first copy supervises, and only then
  // discover the port is taken. Holding the port first makes that second copy exit having touched
  // nothing.
  await listen();
  // Best-effort: leftovers from a previous run are not a reason to refuse to come up.
  await reapOrphans().catch((err) => console.error(`[paddock] orphan reap failed: ${err.message}`));
  // A cache: an unreadable one costs icons until each service runs again, not the startup.
  await loadFavicons().catch((err) => console.error(`[paddock] favicon cache unreadable: ${err.message}`));
  startEvents();
  markReady();
  // Printed last, so the line means "usable" — tests and scripts/dev.js wait for it.
  const { port } = server.address();
  console.log(`[paddock] UI   http://${displayHost}:${port}`);
  console.log(`[paddock] MCP  http://${displayHost}:${port}/mcp`);
  // Last, and not awaited. After the port is held, so a second copy never starts anything; after the
  // reaper, so a leftover from a crashed run has released its port before its replacement binds it;
  // and after the startup line, so the dashboard is usable while the applications come up in it.
  autoStart();
}

/** One line per auto-started application, naming whatever did not come up and why. */
async function autoStart() {
  const outcomes = await autoStartApplications().catch((err) => {
    console.error(`[paddock] auto-start failed: ${err.message}`);
    return [];
  });
  for (const { name, results, error } of outcomes) {
    const failed = results.filter((result) => !result.ok);
    const detail = error ?? failed.map((result) => `${result.name}: ${result.error ?? result.status}`).join(', ');
    const up = `${results.length - failed.length}/${results.length} up`;
    console.error(`[paddock] auto-start ${name}: ${detail ? `${up} — ${detail}` : up}`);
  }
}

// Node hands the handler the signal name, so one handler body serves all three.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, (name) => shutdown(name));

// Last resort only, and synchronous: async work inside 'exit' is discarded, and this handler does
// not run at all when a signal terminates the process — the handlers above are what normally clean up.
process.on('exit', killAllSync);

await main();
