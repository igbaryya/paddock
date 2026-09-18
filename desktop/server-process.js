/**
 * The Paddock server as the app runs it: the same server.js `npm start` runs, forked into an Electron
 * utility process. The dashboard and /mcp are exactly what a checkout serves, and nothing about
 * supervising dev servers moves into the app.
 *
 * The app starts a server only on a free port. A Paddock already on it — a checkout's login agent, an
 * `npm start` — is used as it is. Anything else holding it is for the user to resolve, because that
 * port is the MCP URL their agents are configured with.
 *
 * Stopping is a message, not a signal: Windows has none to send, and server.js runs the same graceful
 * shutdown for either. `kill()` is only the fallback for a server that does not finish in time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { utilityProcess } from 'electron';
import { importServerModule } from './server-dir.js';

const { createLineSplitter } = await importServerModule('line-splitter.js');

/** A starting Paddock answers once it has reaped, which is milliseconds; a hung one never does. */
const PROBE_TIMEOUT_MS = 5_000;

/** How much of the server's output is kept to explain a start that failed. */
const TAIL_LINES = 20;

/** Printed last by server.js, so it is the line that means "usable" — and it carries the URL. */
const READY_LINE = /^\[paddock\] UI\s+(\S+)/;

/** Over the server's own shutdown ceiling, so its SIGKILL escalation always gets to run first. */
const STOP_MARGIN_MS = 5_000;

/** A pipe inherited by something the server left behind never ends; its exit must still be reported. */
const DRAIN_TIMEOUT_MS = 1_000;

/**
 * What is listening where the server would.
 * @param {string} origin
 * @returns {Promise<{state: 'free'} | {state: 'paddock', pid: number} | {state: 'taken'}>}
 */
export async function probe(origin) {
  let response;
  try {
    response = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    // Refused is the only answer that proves nothing is there; a timeout is something that is.
    return err.cause?.code === 'ECONNREFUSED' ? { state: 'free' } : { state: 'taken' };
  }
  const body = await response.json().catch(() => null);
  return body?.service === 'paddock' ? { state: 'paddock', pid: body.pid } : { state: 'taken' };
}

/**
 * @param {{serverDir: string, env: Record<string, string>, logFile: string, stopGraceMs: number,
 *          onRequest: (action: string) => Promise<unknown>}} options
 * @returns {{ready: Promise<string>, exited: Promise<{code: number, output: string}>,
 *            stop: () => Promise<void>}} `ready` resolves with the dashboard URL and rejects if the
 *   server exits first; `stop` can be called any number of times and stops it once
 */
export function startServer({ serverDir, env, logFile, stopGraceMs, onRequest }) {
  const child = utilityProcess.fork(path.join(serverDir, 'server.js'), [], {
    cwd: serverDir,
    env,
    stdio: 'pipe',
    serviceName: 'Paddock server',
  });
  const output = recordOutput(logFile);
  let running = true;
  let markReady;
  const readyLine = new Promise((resolve) => {
    markReady = resolve;
  });
  const drained = Promise.all([
    followLines(child.stdout, (line) => {
      output.write(line);
      const match = READY_LINE.exec(line);
      if (match) markReady(match[1]);
    }),
    followLines(child.stderr, output.write),
  ]);
  const exitCode = new Promise((resolve) => {
    child.once('exit', (code) => {
      running = false;
      resolve(code);
    });
  });
  // The line that explains an exit is written just before it, and the pipe can deliver it after.
  const exited = exitCode.then(async (code) => {
    await Promise.race([drained, delay(DRAIN_TIMEOUT_MS)]);
    return { code, output: output.tail() };
  });
  const ready = Promise.race([
    readyLine,
    exited.then(({ code, output: tail }) => {
      throw new Error(`The server exited with code ${code}.\n\n${tail}`);
    }),
  ]);
  child.on('message', (message) => answer(message, onRequest, (reply) => running && child.postMessage(reply)));

  let stopping = null;
  const stop = () => {
    stopping ??= running ? stopGracefully(child, exited, stopGraceMs + STOP_MARGIN_MS) : Promise.resolve();
    return stopping;
  };
  return { ready, exited, stop };
}

/** @param {import('electron').UtilityProcess} child @param {Promise<unknown>} exited @param {number} timeoutMs */
async function stopGracefully(child, exited, timeoutMs) {
  child.postMessage({ type: 'shutdown' });
  const finished = await Promise.race([exited.then(() => true), delay(timeoutMs, false)]);
  if (finished) return;
  child.kill();
  await exited;
}

/**
 * The server's requests of the app (see platform/desktop.js). Every request gets a reply, an error
 * included, so the server never waits out its timeout on something the app already knows.
 * @param {any} message
 * @param {(action: string) => Promise<unknown>} onRequest
 * @param {(reply: object) => void} send
 */
async function answer(message, onRequest, send) {
  if (message?.type !== 'request') return;
  try {
    send({ type: 'reply', id: message.id, result: await onRequest(message.action) });
  } catch (err) {
    send({ type: 'reply', id: message.id, error: err.message });
  }
}

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {(line: string) => void} onLine
 * @returns {Promise<void>} settles once the stream has ended and its last line has been handed on
 */
function followLines(stream, onLine) {
  const splitter = createLineSplitter();
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => splitter.push(chunk).forEach(onLine));
  return new Promise((resolve) => {
    stream.on('end', () => {
      splitter.flush().forEach(onLine);
      resolve();
    });
  });
}

/**
 * The server's own lines go where a login agent would have put them — the log Settings names — and
 * to this process's output for a terminal running the app. The last few are kept to explain a
 * failed start.
 * @param {string} logFile
 */
function recordOutput(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const file = fs.createWriteStream(logFile, { flags: 'a' });
  const lines = [];
  return {
    write(line) {
      file.write(`${line}\n`);
      console.log(line);
      lines.push(line);
      if (lines.length > TAIL_LINES) lines.shift();
    },
    tail: () => lines.join('\n'),
  };
}
