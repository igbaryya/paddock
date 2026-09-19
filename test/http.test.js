/**
 * End-to-end tests for the HTTP surface: REST, the local-origin guard, the static UI, the MCP
 * endpoint and the SSE stream.
 *
 * The real `server.js` is spawned as a child process with `PADDOCK_PORT=0` and a per-file temp
 * data directory, and the bound port is read back from its startup line — so the suite is hermetic,
 * parallel-safe, and touches neither the developer's data directory nor a fixed port.
 *
 * Two of the things under test cannot be expressed with `fetch`: a forged `Host`/`Origin` header,
 * and a request target containing `..` (the URL parser collapses it before it is sent). Those go
 * through `raw()`, a minimal HTTP/1.1 client over `node:net` that writes the request line verbatim.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_START_TIMEOUT_MS = 20_000;
const SSE_EVENT_TIMEOUT_MS = 20_000;

/** @type {import('node:child_process').ChildProcess} */
let server;
let port;
let mcpPort;
let dataDir;
let repoDir;
let serverStderr = '';
let serverExit = null;

const baseUrl = () => `http://127.0.0.1:${port}`;

/** @param {string} p @param {RequestInit} [init] */
async function api(p, init) {
  const res = await fetch(`${baseUrl()}${p}`, { signal: AbortSignal.timeout(15_000), ...init });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text,
    json: () => JSON.parse(text),
  };
}

const postJson = (p, body) =>
  api(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const putJson = (p, body) =>
  api(p, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * A request written byte for byte onto the socket: the only way to forge a Host/Origin header or to
 * send a target the URL parser would normalise away.
 * @param {{method?:string, target:string, headers?:Record<string,string>, body?:string,
 *          version?:string}} spec
 * @returns {Promise<{status:number, headers:Record<string,string>, body:string, reset:boolean}>}
 */
function raw({ method = 'GET', target, headers = {}, body = '', version = 'HTTP/1.1', connectPort = port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(connectPort, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw ${method} ${target} timed out after 15s`));
    }, 15_000);
    let received = Buffer.alloc(0);
    let reset = false;

    const finish = () => {
      clearTimeout(timer);
      const text = received.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) {
        reject(new Error(`raw ${method} ${target}: no complete response head (got ${text.length}b)`));
        return;
      }
      const [statusLine, ...headerLines] = text.slice(0, split).split('\r\n');
      const parsed = {};
      for (const line of headerLines) {
        const at = line.indexOf(':');
        parsed[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers: parsed,
        body: text.slice(split + 4),
        reset,
      });
    };

    socket.on('connect', () => {
      const all = { Host: `127.0.0.1:${connectPort}`, Connection: 'close', ...headers };
      if (body) all['Content-Length'] = String(Buffer.byteLength(body));
      // An explicit `undefined` means "omit this header entirely" — that is how a Host-less
      // request, which the guard must reject, is expressed.
      const head = [
        `${method} ${target} ${version}`,
        ...Object.entries(all).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${head.join('\r\n')}\r\n\r\n${body}`, () => {});
    });
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    socket.on('close', finish);
    // A rejected oversized body is answered and then the socket is torn down: keep what arrived.
    socket.on('error', (err) => {
      reset = true;
      if (received.length) return finish();
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * One MCP request over Streamable HTTP, driven with raw `fetch` rather than the SDK client so the
 * wire contract (the Accept header, the SSE framing of the response) is what is under test.
 * @param {object} payload a JSON-RPC message
 */
const mcpBaseUrl = () => `http://127.0.0.1:${mcpPort}`;

async function mcp(payload, headers = {}) {
  const res = await fetch(`${mcpBaseUrl()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    return { status: res.status, contentType, message: text ? JSON.parse(text) : null };
  }
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  assert.equal(data.length, 1, `expected one SSE data line, got ${data.length}: ${text}`);
  return { status: res.status, contentType, message: JSON.parse(data[0]) };
}

/** @param {object} result a tools/call result @returns {any} the parsed JSON the tool returned */
function toolPayload(result) {
  assert.equal(result.isError, undefined, `tool reported an error: ${result?.content?.[0]?.text}`);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

let appCounter = 0;
/** Unique per call so no test depends on another's state. @returns {Promise<object>} an ApplicationView */
async function createApplication(label) {
  const res = await postJson('/api/applications', { name: `${label}-${++appCounter}` });
  assert.equal(res.status, 200, res.text);
  return res.json();
}

async function startServer() {
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-test-')));
  repoDir = path.join(dataDir, 'repo');
  await fs.mkdir(repoDir);

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: dataDir,
      PADDOCK_PORT: '0',
      PADDOCK_HOST: '127.0.0.1',
      // The project .env must never leak into a test run.
      PADDOCK_ENV_FILE: path.join(dataDir, 'absent.env'),
      PADDOCK_REAP_ORPHANS: 'false',
      PADDOCK_START_SETTLE_MS: '200',
      PADDOCK_STOP_GRACE_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { serverStderr += chunk; });
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });

  port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new Error(`server never announced a port.\nstdout:${stdout}\nstderr:${serverStderr}`)),
      SERVER_START_TIMEOUT_MS
    );
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/UI\s+http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}: ${serverStderr}`)));
  });
  assert.ok(port > 0, 'the ephemeral port must be a real port number');
}

async function installMcpForTests() {
  mcpPort = port + 10_000;
  const res = await postJson('/api/mcp/configure', { port: mcpPort });
  assert.equal(res.status, 200, res.text);
  const view = res.json();
  assert.equal(view.running, true);
  assert.equal(view.boundPort, mcpPort);
}

before(async () => {
  await startServer();
  await installMcpForTests();
}, { timeout: SERVER_START_TIMEOUT_MS + 5_000 });

after(async () => {
  if (server && serverExit === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server ignored SIGTERM')), 15_000)),
    ]);
  }
  // The temp directory goes first: an assertion below must never be the reason one is left behind.
  await fs.rm(dataDir, { recursive: true, force: true });
  assert.notEqual(serverExit, null, 'the server process must have exited');
  assert.deepEqual(serverExit, { code: 0, signal: null }, `server exit was not clean: ${serverStderr}`);
});

test('REST: create, add a process, list, get, patch and delete round-trips through ApplicationView', async () => {
  const created = await createApplication('crud');
  assert.match(created.id, /^app_[a-z0-9]{12}$/);
  assert.equal(created.status, 'stopped');
  assert.deepEqual(created.processes, []);
  assert.deepEqual(created.processCounts, {
    total: 0, enabled: 0, running: 0, stopped: 0, crashed: 0, failed: 0,
  });
  assert.equal(typeof created.createdAt, 'string');
  assert.equal(created.description, '');

  const added = await postJson(`/api/applications/${created.id}/processes`, {
    name: 'web',
    repositoryPath: repoDir,
    command: 'sleep 30',
    env: { EXAMPLE: 'yes' },
  });
  assert.equal(added.status, 200, added.text);
  const withProcess = added.json();
  assert.equal(withProcess.processes.length, 1);
  const proc = withProcess.processes[0];
  assert.match(proc.id, /^proc_[a-z0-9]{12}$/);
  assert.deepEqual(
    { ...proc, id: undefined },
    {
      id: undefined,
      name: 'web',
      repositoryPath: repoDir,
      command: 'sleep 30',
      // Absent workingDirectory resolves to the repository root in the view.
      workingDirectory: repoDir,
      env: { EXAMPLE: 'yes' },
      enabled: true,
      status: 'stopped',
      pid: null,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      exitSignal: null,
      lastError: null,
      restarts: 0,
      uptimeMs: null,
      // Decorated from the last port scan; `[]` once one has run, `null` before that.
      ports: proc.ports,
      // A `sleep` serves nothing, so it never has one.
      favicon: null,
    }
  );
  assert.ok(proc.ports === null || Array.isArray(proc.ports), 'ports is null or an array');
  assert.deepEqual(withProcess.processCounts, {
    total: 1, enabled: 1, running: 0, stopped: 1, crashed: 0, failed: 0,
  });

  const listed = await api('/api/applications');
  assert.equal(listed.status, 200);
  const mine = listed.json().find((a) => a.id === created.id);
  assert.equal(mine.processes.length, 1);

  const fetched = await api(`/api/applications/${created.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.json(), mine);

  const patched = await api(`/api/applications/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'patched description' }),
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json().description, 'patched description');
  assert.equal(patched.json().name, created.name, 'a patch must not disturb an unnamed field');

  const patchedProc = await api(`/api/applications/${created.id}/processes/${proc.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'sleep 31', enabled: false }),
  });
  assert.equal(patchedProc.status, 200, patchedProc.text);
  const updatedProc = patchedProc.json().processes[0];
  assert.equal(updatedProc.command, 'sleep 31');
  assert.equal(updatedProc.enabled, false);
  assert.equal(
    updatedProc.configChangedWhileRunning,
    undefined,
    'a stopped process must not be marked as changed-while-running'
  );

  const removedProc = await api(`/api/applications/${created.id}/processes/${proc.id}`, {
    method: 'DELETE',
  });
  assert.equal(removedProc.status, 204);
  assert.equal(removedProc.text, '');
  assert.equal((await api(`/api/applications/${created.id}`)).json().processes.length, 0);

  const deleted = await api(`/api/applications/${created.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await api(`/api/applications/${created.id}`)).status, 404);
});

// The canvas saves an arrangement on every drop, so this route is the most frequently written one in
// the API. It answers with the layout alone — the dashboard already has the application, and sending
// the whole view back on each drop would have every drag fight the list it is drawn from.
test('a dragged arrangement is stored, comes back on the application, and is replaced wholesale', async () => {
  const app = await createApplication('layout');
  assert.deepEqual((await api(`/api/applications/${app.id}`)).json().layout, {});

  const saved = await putJson(`/api/applications/${app.id}/layout`, {
    layout: { '@application': { x: 0, y: 120 }, '@connection': { x: 320.4, y: 0 } },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json(), {
    layout: { '@application': { x: 0, y: 120 }, '@connection': { x: 320, y: 0 } },
  });
  assert.deepEqual((await api(`/api/applications/${app.id}`)).json().layout, saved.json().layout);

  const cleared = await putJson(`/api/applications/${app.id}/layout`, { layout: {} });
  assert.deepEqual(cleared.json(), { layout: {} });

  const bad = await putJson(`/api/applications/${app.id}/layout`, {
    layout: { '@application': { x: 'left', y: 0 } },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json().error.code, 'validation_error');
  assert.match(bad.json().error.message, /layout x/);

  const missing = await putJson('/api/applications/app_nosuchthing/layout', { layout: {} });
  assert.equal(missing.status, 404, missing.text);

  await api(`/api/applications/${app.id}`, { method: 'DELETE' });
});

// With Paddock running as a login agent, starting a second copy by hand is the expected mistake. The
// second copy shares the data directory, and its orphan reaper treats every record in runtime.json as
// belonging to a dead run — so if it reaped before discovering the port was taken, it would kill every
// service the running copy supervises and only then exit.
test('a second instance on a taken port exits without touching the running one\'s services', async () => {
  const app = await createApplication('second-instance');
  await postJson(`/api/applications/${app.id}/processes`, {
    name: 'survivor',
    repositoryPath: repoDir,
    command: 'sleep 30',
  });
  const started = (await postJson(`/api/applications/${app.id}/start`, {})).json();
  const { pid } = started.application.processes[0];
  assert.equal(started.results[0].status, 'running');

  // The record is written asynchronously after the spawn; the reaper can only kill what is recorded.
  const runtimeFile = path.join(dataDir, 'runtime.json');
  const deadline = Date.now() + 5_000;
  for (;;) {
    const raw = await fs.readFile(runtimeFile, 'utf8').catch(() => '');
    if (raw.includes(`"pgid": ${pid}`)) break;
    assert.ok(Date.now() < deadline, `runtime.json never recorded pgid ${pid}: ${raw}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const second = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: dataDir,
      PADDOCK_PORT: String(port),
      PADDOCK_HOST: '127.0.0.1',
      PADDOCK_ENV_FILE: path.join(dataDir, 'absent.env'),
      PADDOCK_REAP_ORPHANS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  second.stderr.setEncoding('utf8');
  second.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(second, 'exit');

  assert.equal(code, 1, `the second instance should refuse to start: ${stderr}`);
  assert.match(stderr, /already in use/);
  assert.doesNotMatch(stderr, /reaped/);
  assert.doesNotThrow(() => process.kill(pid, 0), 'the running instance\'s service was killed');
  const view = (await api(`/api/applications/${app.id}`)).json();
  assert.equal(view.processes[0].status, 'running');

  await postJson(`/api/applications/${app.id}/stop`, {});
});

/**
 * A Paddock of its own, on its own data directory, resolved once it prints its startup line — for
 * the tests that are about a server starting, which the shared one has already done.
 * @param {string} ownDataDir
 * @returns {Promise<{child: import('node:child_process').ChildProcess, base: string,
 *                    output: () => string}>} `output` is everything it has printed so far
 */
async function spawnPaddock(ownDataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: ownDataDir,
      PADDOCK_PORT: '0',
      PADDOCK_HOST: '127.0.0.1',
      PADDOCK_ENV_FILE: path.join(ownDataDir, 'absent.env'),
      PADDOCK_REAP_ORPHANS: 'false',
      PADDOCK_START_SETTLE_MS: '200',
      PADDOCK_STOP_GRACE_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (const deadline = Date.now() + SERVER_START_TIMEOUT_MS; ;) {
    const match = output.match(/UI\s+http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return { child, base: `http://127.0.0.1:${match[1]}`, output: () => output };
    assert.ok(Date.now() < deadline && child.exitCode === null, `server never came up: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const stopPaddock = async ({ child }) => {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};

// Through a real restart: the flag is written by one Paddock and acted on by the next, which is the
// only way to prove it survives on disk and runs at startup rather than whenever the flag is set.
test('a restarted Paddock starts the applications marked to auto-start, and only those', async () => {
  const ownDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-autostart-'));
  const ownRepo = path.join(ownDataDir, 'repo');
  await fs.mkdir(ownRepo);
  const request = (base, p, method = 'GET', body) =>
    fetch(`${base}${p}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then((res) => res.json());

  let paddock = await spawnPaddock(ownDataDir);
  try {
    const ids = {};
    for (const [name, autoStart] of [['marked', true], ['unmarked', false]]) {
      const app = await request(paddock.base, '/api/applications', 'POST', { name, autoStart });
      await request(paddock.base, `/api/applications/${app.id}/processes`, 'POST', {
        name: 'svc', repositoryPath: ownRepo, command: 'sleep 30',
      });
      ids[name] = app.id;
    }
    await stopPaddock(paddock);

    paddock = await spawnPaddock(ownDataDir);
    const statusOf = async (id) => (await request(paddock.base, `/api/applications/${id}`)).processes[0].status;
    for (const deadline = Date.now() + 10_000; (await statusOf(ids.marked)) !== 'running';) {
      assert.ok(Date.now() < deadline, `the marked application never came up: ${paddock.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await statusOf(ids.unmarked), 'stopped');
    assert.match(paddock.output(), /auto-start marked: 1\/1 up/);
  } finally {
    await stopPaddock(paddock);
    await fs.rm(ownDataDir, { recursive: true, force: true });
  }
});

test('GET /api/settings reports the login switch and this copy', async () => {
  const res = await api('/api/settings');
  assert.equal(res.status, 200);
  const { startAtLogin, instance } = res.json();
  assert.equal(typeof startAtLogin.enabled, 'boolean');
  assert.equal(typeof startAtLogin.location, 'string');
  assert.ok(Array.isArray(startAtLogin.problems));
  // This server was spawned by the suite, not by a login entry.
  assert.equal(startAtLogin.launchedAtLogin, false);
  assert.deepEqual(
    { pid: instance.pid, installDir: instance.installDir, dataDir: instance.dataDir },
    { pid: server.pid, installDir: ROOT_DIR, dataDir }
  );
});

// Only the refusals are exercised here: a successful PATCH would write the entry into the real home
// directory of whoever runs the suite. The entries themselves are covered in login-item.test.js.
test('PATCH /api/settings refuses a startAtLogin that is not a boolean, and an empty patch changes nothing', async () => {
  const before = (await api('/api/settings')).json();

  const refused = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startAtLogin: 'yes' }),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json().error.message, /startAtLogin must be true or false/);

  const empty = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.json().startAtLogin.enabled, before.startAtLogin.enabled);
});

test('GET /api/health reports ok, names the service, and gives the server pid', async () => {
  const res = await api('/api/health');
  assert.equal(res.status, 200);
  const body = res.json();
  // The desktop app attaches to whatever answers this with `paddock`, and refuses anything else.
  assert.equal(body.service, 'paddock');
  assert.equal(body.status, 'ok');
  assert.equal(body.pid, server.pid);
  assert.equal(typeof body.uptimeMs, 'number');
});

test('GET /api/workspace/directory browses a real directory by query parameter', async () => {
  await fs.mkdir(path.join(repoDir, 'packages'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'notes.txt'), 'a file, not a directory');

  const res = await api(`/api/workspace/directory?path=${encodeURIComponent(repoDir)}`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.path, repoDir);
  assert.equal(body.parent, path.dirname(repoDir));
  assert.deepEqual(
    body.entries.map((entry) => entry.name),
    ['packages']
  );
});

test('GET /api/workspace/inspect reports the scripts and the .env of that directory', async () => {
  await fs.writeFile(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { dev: 'sleep 30' } })
  );
  await fs.writeFile(path.join(repoDir, '.env'), 'TOKEN=abc\nEMPTY=\nPORT=8080');

  const res = await api(`/api/workspace/inspect?path=${encodeURIComponent(repoDir)}`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.packageName, 'fixture');
  assert.deepEqual(body.scripts, [{ name: 'dev', script: 'sleep 30', command: 'npm run dev' }]);
  assert.deepEqual(body.envFiles[0].variables, [
    { key: 'TOKEN', value: 'abc' },
    { key: 'EMPTY', value: '' },
    { key: 'PORT', value: '8080' },
  ]);
});

test('a browse with no path opens at the home directory; an inspect with none is 400', async () => {
  const browse = await api('/api/workspace/directory');
  assert.equal(browse.status, 200);
  assert.equal(browse.json().path, os.homedir());

  const inspect = await api('/api/workspace/inspect');
  assert.equal(inspect.status, 400);
  assert.equal(inspect.json().error.code, 'validation_error');
});

test('a workspace path that is a file is 400, with the same wording as a saved path', async () => {
  const file = path.join(repoDir, 'notes.txt');
  await fs.writeFile(file, 'a file, not a directory');
  const res = await api(`/api/workspace/directory?path=${encodeURIComponent(file)}`);
  assert.equal(res.status, 400);
  assert.match(res.json().error.message, /is not a directory/);
});

test('a missing name is 400 with an error envelope naming the field', async () => {
  const res = await postJson('/api/applications', { description: 'no name here' });
  assert.equal(res.status, 400);
  const { error } = res.json();
  assert.equal(error.code, 'validation_error');
  assert.match(error.message, /application name must be a non-empty string/);
});

test('a relative repositoryPath is 400 and the message names repositoryPath', async () => {
  const app = await createApplication('bad-path');
  const res = await postJson(`/api/applications/${app.id}/processes`, {
    name: 'web',
    repositoryPath: 'relative/dir',
    command: 'sleep 30',
  });
  assert.equal(res.status, 400);
  const { error } = res.json();
  assert.equal(error.code, 'validation_error');
  assert.match(error.message, /^repositoryPath must be an absolute path/);
});

test('a non-integer query parameter is 400 naming the parameter', async () => {
  const app = await createApplication('bad-query');
  const res = await api(`/api/applications/${app.id}/logs?limit=abc`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), {
    error: { message: 'Query parameter "limit" must be a non-negative integer', code: 'validation_error' },
  });
});

test('an unknown application id is 404 with code not_found', async () => {
  const res = await api('/api/applications/app_000000000000');
  assert.equal(res.status, 404);
  const { error } = res.json();
  assert.equal(error.code, 'not_found');
  assert.match(error.message, /app_000000000000/);
});

test('an unknown API route is 404, not 500', async () => {
  const res = await api('/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.json(), {
    error: { message: 'No API route for GET /api/nope', code: 'not_found' },
  });
});

test('a malformed JSON body is 400, not 500', async () => {
  const res = await api('/api/applications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name": "broken",',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), {
    error: { message: 'Request body is not valid JSON', code: 'validation_error' },
  });
});

test('a JSON body that is not an object is 400', async () => {
  const res = await api('/api/applications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '["name"]',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json().error.message, 'Request body must be a JSON object');
});

test('a body over the 1 MiB limit is rejected and the application is not created', async () => {
  const body = JSON.stringify({ name: 'oversized-body-app', padding: 'x'.repeat(1_100_000) });
  const res = await raw({
    method: 'POST',
    target: '/api/applications',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: { message: 'Request body exceeds 1048576 bytes', code: 'validation_error' },
  });
  const names = (await api('/api/applications')).json().map((a) => a.name);
  assert.equal(names.includes('oversized-body-app'), false);
});

test('the local-origin guard rejects a forged Host header with 403', async () => {
  const res = await raw({ target: '/api/health', headers: { Host: 'evil.com' } });
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: { message: 'local requests only', code: 'forbidden' },
  });
});

test('the local-origin guard rejects a foreign Origin with 403', async () => {
  const res = await raw({
    target: '/api/health',
    headers: { Origin: 'https://evil.com' },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'forbidden');
});

test('the guard is port-agnostic: a loopback Origin on the Vite dev port is allowed', async () => {
  for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
    const res = await raw({ target: '/api/health', headers: { Origin: origin } });
    assert.equal(res.status, 200, `${origin} must be allowed — port-matching would break npm run dev`);
    assert.equal(JSON.parse(res.body).status, 'ok');
  }
});

test('a request with no Host header at all is refused', async () => {
  // HTTP/1.1 makes Host mandatory and Node's own parser answers 400 before the guard is reached, so
  // the guard's missing-Host branch is only observable over HTTP/1.0.
  const eleven = await raw({ target: '/api/health', headers: { Host: undefined } });
  assert.equal(eleven.status, 400);

  const ten = await raw({ target: '/api/health', headers: { Host: undefined }, version: 'HTTP/1.0' });
  assert.equal(ten.status, 403);
  assert.deepEqual(JSON.parse(ten.body), {
    error: { message: 'local requests only', code: 'forbidden' },
  });
});

test('GET / serves the built SPA shell as HTML', async () => {
  const res = await api('/');
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/html; charset=utf-8');
  assert.match(res.text, /<div id="root"><\/div>/);
});

test('a missing asset is 404 and is not the HTML shell', async () => {
  const res = await api('/nope.js');
  assert.equal(res.status, 404);
  assert.equal(res.text, '');
  assert.equal(
    /text\/html/.test(res.contentType ?? ''),
    false,
    'a missing .js must never come back as HTML under a JavaScript content type'
  );
});

test('an extension-less deep path falls back to the SPA shell', async () => {
  const shell = await api('/');
  const deep = await api('/applications/app_123456789012/logs');
  assert.equal(deep.status, 200);
  assert.equal(deep.contentType, 'text/html; charset=utf-8');
  assert.equal(deep.text, shell.text);
});

test('path traversal never serves a file from outside the UI directory', async () => {
  for (const target of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/../../../../etc/passwd']) {
    const res = await raw({ target });
    assert.equal(
      res.body.includes('root:'),
      false,
      `${target} leaked content from outside ui/dist: ${res.body.slice(0, 120)}`
    );
    assert.ok(
      res.status === 200 || res.status === 404,
      `${target} answered with an unexpected ${res.status}`
    );
    if (res.status === 200) {
      // The legitimate answer is the SPA shell; it must be the shell and nothing else.
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(res.body, /<div id="root"><\/div>/);
    }
  }
});

test('MCP initialize returns the paddock server info over SSE framing', async () => {
  const res = await mcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /^text\/event-stream/);
  assert.equal(res.message.jsonrpc, '2.0');
  assert.equal(res.message.id, 1);
  assert.deepEqual(res.message.result.serverInfo, { name: 'paddock', version: '1.0.0' });
  assert.deepEqual(res.message.result.capabilities.tools, { listChanged: true });
  assert.match(res.message.result.instructions, /list_applications/);
});

test('MCP tools/list returns exactly the twenty-one contract tools', async () => {
  const res = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(res.status, 200);
  const names = res.message.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_application',
    'list_applications',
    'read_logs',
    'restart_application',
    'restart_process',
    'start_application',
    'start_process',
    'stop_application',
    'stop_process',
    'list_listening_ports',
    'get_port_info',
    'stop_port',
    'cluster_info',
    'list_databases',
    'list_schemas',
    'list_tables',
    'describe_table',
    'query',
    'execute',
    'create_database',
    'drop_database',
  ].sort());
});

test('MCP database tools refuse an application that is not a PostgreSQL one, naming why', async () => {
  const app = await createApplication('mcp-not-postgres');
  const res = await mcp({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name: 'list_databases', arguments: { application_id: app.id } },
  });
  assert.equal(res.message.result.isError, true);
  assert.match(res.message.result.content[0].text, /ValidationError: .*not a PostgreSQL application/);
});

test('MCP database tools against a server that is not running say so, instead of trying to connect', async () => {
  const clusterDir = path.join(dataDir, `stopped-cluster-${++appCounter}`);
  await fs.mkdir(clusterDir);
  await fs.writeFile(path.join(clusterDir, 'PG_VERSION'), '16\n');
  const created = await postJson('/api/applications', {
    name: `pg-stopped-${appCounter}`,
    kind: 'postgres',
    postgres: { dataDirectory: clusterDir, port: 1 },
  });
  assert.equal(created.status, 200, created.text);

  const res = await mcp({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'cluster_info', arguments: { application_id: created.json().id } },
  });
  assert.equal(res.message.result.isError, true);
  assert.match(res.message.result.content[0].text, /ValidationError: .*is stopped — start it first/);
});

test('POST /api/applications with kind postgres and a directory initdb never touched is a 400', async () => {
  const res = await postJson('/api/applications', {
    name: `pg-not-a-cluster-${++appCounter}`,
    kind: 'postgres',
    postgres: { dataDirectory: repoDir },
  });
  assert.equal(res.status, 400, res.text);
  assert.match(res.json().error.message, /PG_VERSION/);
});

test('MCP list_applications succeeds when the client sends no arguments member at all', async () => {
  const app = await createApplication('mcp-no-args');
  const res = await mcp({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    // No `arguments` key: `inputSchema: {}` would reject this (FINDINGS H4).
    params: { name: 'list_applications' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.message.error, undefined, JSON.stringify(res.message.error));
  const applications = toolPayload(res.message.result);
  assert.ok(Array.isArray(applications), 'list_applications must return an array of ApplicationView');
  assert.equal(applications.some((a) => a.id === app.id), true);
});

test('MCP get_application returns the same view shape the REST layer serves', async () => {
  const app = await createApplication('mcp-parity');
  const res = await mcp({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_application', arguments: { application_id: app.id } },
  });
  assert.deepEqual(toolPayload(res.message.result), (await api(`/api/applications/${app.id}`)).json());
});

test('MCP reports an unknown application as a tool error, not a protocol error', async () => {
  const res = await mcp({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_application', arguments: { application_id: 'app_000000000000' } },
  });
  assert.equal(res.message.error, undefined);
  assert.equal(res.message.result.isError, true);
  assert.match(res.message.result.content[0].text, /NotFoundError: application/);
});

test('GET /mcp on the dashboard port explains MCP moved to its own listener', async () => {
  const res = await fetch(`${baseUrl()}/mcp`, { signal: AbortSignal.timeout(5_000) });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'mcp_moved');
});

test('GET /mcp on the MCP port is 405 with Allow: POST and closes instead of hanging', async () => {
  const res = await fetch(`${mcpBaseUrl()}/mcp`, { signal: AbortSignal.timeout(5_000) });
  const body = await res.text();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  const message = JSON.parse(body);
  assert.equal(message.jsonrpc, '2.0');
  assert.equal(message.error.code, -32_000);
  assert.match(message.error.message, /GET is not supported/);
});

test('a forged Host on /mcp is refused by the local-origin guard', async () => {
  const res = await raw({
    method: 'POST',
    target: '/mcp',
    connectPort: mcpPort,
    headers: {
      Host: 'evil.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: { message: 'local requests only', code: 'forbidden' },
  });
});

test('SSE delivers a log event for a started process and survives the client disconnecting', async () => {
  const app = await createApplication('sse');
  const added = await postJson(`/api/applications/${app.id}/processes`, {
    name: 'talker',
    repositoryPath: repoDir,
    // Prints once, then stays alive so the test controls when it dies.
    command: 'printf "hello-from-sse\\n"; sleep 30',
  });
  assert.equal(added.status, 200, added.text);
  const procId = added.json().processes[0].id;

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl()}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform');

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames = [];
  /** @returns {Promise<void>} resolves once `predicate` matches a frame that has arrived */
  const readUntil = async (predicate, what) => {
    const deadline = Date.now() + SSE_EVENT_TIMEOUT_MS;
    for (;;) {
      if (frames.some(predicate)) return;
      if (Date.now() > deadline) throw new Error(`no SSE frame matching ${what}; saw ${JSON.stringify(frames)}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`SSE stream ended before ${what}`);
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split('\n\n');
      buffered = parts.pop();
      for (const part of parts) {
        const event = part.match(/^event: (.+)$/m)?.[1];
        const data = part.match(/^data: (.*)$/m)?.[1];
        frames.push({ event: event ?? null, data: data ? JSON.parse(data) : null, raw: part });
      }
    }
  };

  await readUntil((f) => f.raw.startsWith(': connected'), 'the connection preamble');

  const started = await postJson(`/api/applications/${app.id}/processes/${procId}/start`);
  assert.equal(started.status, 200, started.text);
  assert.equal(
    ['starting', 'running'].includes(started.json().processes[0].status),
    true,
    `unexpected status after start: ${started.json().processes[0].status}`
  );

  await readUntil(
    (f) => f.event === 'log' && f.data.some((e) => e.entry.message === 'hello-from-sse'),
    'a log event carrying the child output'
  );
  const logFrame = frames.find((f) => f.event === 'log');
  const entry = logFrame.data.find((e) => e.entry.message === 'hello-from-sse');
  assert.equal(entry.applicationId, app.id);
  assert.equal(entry.processId, procId);
  assert.equal(entry.entry.stream, 'stdout');
  assert.equal(typeof entry.entry.seq, 'number');
  assert.match(entry.entry.ts, /^\d{4}-\d{2}-\d{2}T/);

  // The same line must also be readable through the REST log endpoint.
  const logs = await api(`/api/applications/${app.id}/logs`);
  assert.equal(logs.status, 200);
  const body = logs.json();
  assert.equal(body.application.id, app.id);
  assert.equal(body.dropped, false);
  const rest = body.entries.find((e) => e.message === 'hello-from-sse');
  assert.notEqual(rest, undefined, `log endpoint lost the line: ${logs.text}`);
  assert.equal(rest.processName, 'talker');
  assert.equal(body.nextSeq, Math.max(...body.entries.map((e) => e.seq)) + 1);

  // Drop the client mid-stream: the hub must survive it.
  await reader.cancel().catch(() => {});
  controller.abort();

  const stopped = await postJson(`/api/applications/${app.id}/processes/${procId}/stop`);
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json().processes[0].status, 'stopped');
  assert.equal(stopped.json().processes[0].pid, null);

  const health = await api('/api/health');
  assert.equal(health.status, 200, 'the hub must survive a client vanishing mid-stream');
  assert.equal(health.json().status, 'ok');
});

test('a forged Origin on terminal routes is refused by the local-origin guard', async () => {
  const app = await createApplication('term-guard');
  const res = await raw({
    method: 'GET',
    target: `/api/applications/${app.id}/terminals`,
    headers: { Origin: 'http://evil.com' },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: { message: 'local requests only', code: 'forbidden' },
  });
});

test('GET /api/applications/:id/terminals lists targets and support status', async () => {
  const app = await createApplication('term-list');
  const added = await postJson(`/api/applications/${app.id}/processes`, {
    name: 'worker',
    repositoryPath: repoDir,
    command: 'sleep 30',
  });
  assert.equal(added.status, 200, added.text);
  const procId = added.json().processes[0].id;

  const res = await api(`/api/applications/${app.id}/terminals`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(typeof body.support.available, 'boolean');
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0].processId, procId);
  assert.equal(body.targets[0].cwd, repoDir);
  assert.ok(Array.isArray(body.sessions));
});

test('POST /api/applications/:id/terminals refuses an unknown process id', async () => {
  const app = await createApplication('term-404');
  await postJson(`/api/applications/${app.id}/processes`, {
    name: 'worker',
    repositoryPath: repoDir,
    command: 'sleep 30',
  });
  const res = await postJson(`/api/applications/${app.id}/terminals`, {
    processId: 'proc_not_here',
  });
  assert.equal(res.status, 404);
  assert.match(res.json().error.message, /No terminal target/);
});

test('terminal open, stream, input and close', async (t) => {
  const platform = await import(new URL('../platform/index.js', import.meta.url).href);
  const { available, reason } = await platform.ptyAvailability();
  if (!available) {
    t.skip(reason ?? 'no pseudo-terminal support');
    return;
  }

  const app = await createApplication('term-live');
  const added = await postJson(`/api/applications/${app.id}/processes`, {
    name: 'shell',
    repositoryPath: repoDir,
    command: 'sleep 30',
  });
  assert.equal(added.status, 200, added.text);
  const procId = added.json().processes[0].id;

  const opened = await postJson(`/api/applications/${app.id}/terminals`, {
    processId: procId,
    cols: 80,
    rows: 24,
  });
  assert.equal(opened.status, 200, opened.text);
  const session = opened.json();
  assert.match(session.id, /^[0-9a-f-]{36}$/);

  const stream = await fetch(`${baseUrl()}/api/terminals/${encodeURIComponent(session.id)}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames = [];
  const readUntil = async (predicate, what) => {
    const deadline = Date.now() + SSE_EVENT_TIMEOUT_MS;
    for (;;) {
      if (frames.some(predicate)) return;
      if (Date.now() > deadline) {
        throw new Error(`no terminal SSE frame matching ${what}; saw ${JSON.stringify(frames)}`);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`terminal stream ended before ${what}`);
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split('\n\n');
      buffered = parts.pop();
      for (const part of parts) {
        const event = part.match(/^event: (.+)$/m)?.[1];
        const data = part.match(/^data: (.*)$/m)?.[1];
        frames.push({ event: event ?? null, data: data ? JSON.parse(data) : null });
      }
    }
  };

  const typed = await postJson(`/api/terminals/${session.id}/input`, {
    data: 'printf paddock-http-term\\n',
  });
  assert.equal(typed.status, 204, typed.text);

  await readUntil(
    (f) => f.event === 'data' && f.data.chunk.includes('paddock-http-term'),
    'terminal output from typed command'
  );

  const closed = await fetch(`${baseUrl()}/api/terminals/${session.id}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(closed.status, 204, await closed.text());

  await reader.cancel().catch(() => {});
});
