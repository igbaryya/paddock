/**
 * MCP tool surface over Streamable HTTP — the operations the dashboard offers, handed to an agent.
 * Stateless on purpose: a fresh McpServer and transport per POST, closed with the response,
 * because a reused stateless transport answers with a bare 500 no handler here would ever see.
 * Every tool goes through service.js, so the agent and the UI can never see different shapes, and
 * every input is an id — defining processes stays with the human in the dashboard.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { HOST, PORT } from '../config.js';
import { json as sendJson } from './respond.js';
import {
  listApplications, getApplication, readLogs,
  startApplication, stopApplication, restartApplication,
  startProcess, stopProcess, restartProcess,
  listPorts, getPort, stopPort,
} from '../service.js';

const SERVER_INFO = { name: 'paddock', version: '1.0.0' };

const INSTRUCTIONS =
  'Operate a developer local environment. An application is a named group of local repositories, ' +
  'each with a start command that this manager spawns and supervises. Flow: list_applications ' +
  'for ids and current status, get_application for detail, start/stop/restart at either the ' +
  'application or the single-process level, read_logs for output — pass the next_seq you got ' +
  'back as since_seq to poll for only the new lines. When something will not start because its ' +
  'port is taken, list_listening_ports and get_port_info say what holds it and whether that is ' +
  'one of these applications or something else on the machine, and stop_port frees it by port ' +
  'rather than by pid. Every tool takes ids and port numbers only. There is deliberately no tool ' +
  'to create, edit or delete an application or a process, and no way to run an arbitrary command: ' +
  'you operate what the developer registered, and anything new has to be added by them in the ' +
  'dashboard.';

/** An IPv6 literal is bracketed in a Host header, so a configured `::1` is compared that way. */
const hostAuthority = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/**
 * Host and Origin allowlists for DNS-rebinding protection. The SDK compares the Host header
 * verbatim, port included, so these are built from the port actually bound rather than from
 * `PORT` — which is 0 when the user asked for an ephemeral port. Both lists must stay non-empty:
 * an empty array silently switches that check off (FINDINGS H5).
 * @param {number} port
 */
const allowlistFor = (port) => {
  const hosts = [...new Set(['127.0.0.1', 'localhost', '[::1]', hostAuthority(HOST)])]
    .map((host) => `${host}:${port}`);
  return { hosts, origins: hosts.map((host) => `http://${host}`) };
};

// `?? null` because `JSON.stringify(undefined)` is not a string, and a content block with a
// non-string `text` fails the SDK's result validation as an unreadable protocol error.
const json = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }],
});

/** This text is all the agent gets back, so name the kind — a bad id is worth a retry, a bad
 *  argument is not. Coerced because a thrown non-Error would otherwise produce that same
 *  `text: undefined` and hide the reason behind a protocol error. */
const formatError = (err) => {
  const message = typeof err?.message === 'string' && err.message ? err.message : String(err);
  return err?.name && err.name !== 'Error' ? `${err.name}: ${message}` : message;
};

/** Turn thrown service errors into tool errors the agent can read and retry from. */
const guard = (handler) => async (args) => {
  try {
    return json(await handler(args));
  } catch (err) {
    return { content: [{ type: 'text', text: formatError(err) }], isError: true };
  }
};

/** Our own failures use the JSON-RPC envelope the transport uses, so a client parses both alike. */
const rpcError = (res, status, code, message) =>
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

const application_id = z.string()
  .describe('Application id from list_applications, e.g. app_7c1f9be24d05');
const process_id = z.string()
  .describe('Process id from get_application — the id, never the name');

function registerInspectionTools(server) {
  server.registerTool(
    'list_applications',
    {
      title: 'List applications',
      description:
        'Every application this manager knows about, with its rolled-up status (stopped, ' +
        'starting, running, partial, stopping, failed), process counts, and each process with ' +
        'its command, repository path, pid, uptime and last error. Start here — every other ' +
        'tool needs ids from it.',
    },
    // No inputSchema at all: `{}` would reject a client that sends no `arguments` (FINDINGS H4).
    guard(() => listApplications())
  );

  server.registerTool(
    'get_application',
    {
      title: 'Get application',
      description:
        'One application with the current state of every process in it. Use it to confirm where ' +
        'a start or stop actually landed, and to see a crash that happened after that call ' +
        'returned. Each process also carries `ports`, the ports it was found listening on: `null` ' +
        'means no port scan has run yet rather than none — call list_listening_ports to take one.',
      inputSchema: { application_id },
    },
    guard(({ application_id }) => getApplication(application_id))
  );

  server.registerTool(
    'read_logs',
    {
      title: 'Read logs',
      description:
        'Captured stdout/stderr for an application, or for one process. Returns entries of ' +
        '{seq, ts, stream, processId, processName, message}, ascending by seq and with ANSI ' +
        'stripped, plus next_seq. Pass that next_seq back as since_seq on the following call to ' +
        'get only what was written since — that is how you follow a dev server as it boots ' +
        'instead of re-reading the whole history. `dropped: true` means the buffer evicted lines ' +
        'past your cursor.',
      inputSchema: {
        application_id,
        process_id: process_id.optional()
          .describe('Limit to one process (default: the whole application)'),
        limit: z.number().int().positive().optional()
          .describe('Most entries to return; when more match, the most recent ones come back'),
        since_seq: z.number().int().nonnegative().optional()
          .describe('Only entries with a seq above this — the next_seq from your previous call'),
        stream: z.enum(['stdout', 'stderr']).optional()
          .describe('Limit to one stream (default: both)'),
      },
    },
    guard(async (args) => {
      const { application, process: proc, entries, nextSeq, dropped } = await readLogs({
        applicationId: args.application_id,
        processId: args.process_id,
        limit: args.limit,
        sinceSeq: args.since_seq,
        stream: args.stream,
      });
      // The cursor is snake_case here to match the argument name it is handed back as.
      return { application, process: proc, next_seq: nextSeq, dropped, entries };
    })
  );
}

const port = z.number().int().min(1).max(65_535).describe('TCP port number, e.g. 5173');

function registerPortTools(server) {
  server.registerTool(
    'list_listening_ports',
    {
      title: 'List listening ports',
      description:
        'Every TCP port currently being listened on, with the owning pid and — where it can be ' +
        'established — which configured application and process it belongs to. `owner.kind` is ' +
        'managed (this manager started it), unmanaged (something else on the machine), ambiguous ' +
        '(several configured processes match equally well, so none is claimed) or unknown (the OS ' +
        'named the socket but not its owner). `owner.confidence` says how it was matched; treat ' +
        'medium and low as a hint, not a fact. `exposed: true` means it is reachable beyond ' +
        'loopback. Use this to answer "why can\'t my dev server bind its port?".',
    },
    guard(async () => {
      const { scannedAt, ports, degraded } = await listPorts({ force: true });
      return { scanned_at: scannedAt, degraded, ports };
    })
  );

  server.registerTool(
    'get_port_info',
    {
      title: 'Get port info',
      description:
        'Everything known about what is listening on one port: pid, process name, executable, ' +
        'command line, working directory and the managed process it belongs to, if any. A field ' +
        'is null when the operating system would not tell us — on Windows a working directory is ' +
        'never readable, and another user\'s process hides its command line. Returns an empty ' +
        'usages array when the port is free.',
      inputSchema: { port },
    },
    guard((args) => getPort(args.port))
  );

  server.registerTool(
    'stop_port',
    {
      title: 'Stop whatever is using a port',
      description:
        'Free a port by stopping its current owner. Takes a port, never a pid: the owner is ' +
        're-resolved server-side immediately before acting, so a pid from an earlier listing can ' +
        'never be the thing that gets signalled. A port owned by a managed process is routed ' +
        'through that process\'s own stop, keeping the manager\'s state correct; anything else is ' +
        'signalled politely and then forcefully, with its identity re-checked before each signal. ' +
        'An ambiguous owner is refused rather than guessed. Check `port_released` — a dead ' +
        'process does not always mean a free port, since a sibling may still hold it.',
      inputSchema: { port },
    },
    guard(async (args) => {
      const result = await stopPort(args.port);
      return {
        port: result.port,
        stopped: result.stopped,
        port_released: result.portReleased ?? false,
        still_held_by: result.stillHeldBy ?? [],
        reason: result.reason ?? null,
        results: result.results,
      };
    })
  );
}

function registerApplicationTools(server) {
  server.registerTool(
    'start_application',
    {
      title: 'Start application',
      description:
        'Start every enabled process of the application, in configured order, one after ' +
        'another. A process that fails does not abort the rest, so read the per-process ' +
        '`results` entries (ok, status, error) rather than the application status, which only ' +
        'says "partial".',
      inputSchema: { application_id },
    },
    guard(({ application_id }) => startApplication(application_id))
  );

  server.registerTool(
    'stop_application',
    {
      title: 'Stop application',
      description:
        'Stop every process of the application in reverse configured order, disabled ones ' +
        'included since they may still be running. Each is signalled, force-killed if it ' +
        'outlives the grace period, and reported stopped only once its whole process group is ' +
        'gone. Stopping something already stopped is success, not an error.',
      inputSchema: { application_id },
    },
    guard(({ application_id }) => stopApplication(application_id))
  );

  server.registerTool(
    'restart_application',
    {
      title: 'Restart application',
      description:
        'Stop the whole application, then start it. Everything stops before anything starts, ' +
        'because processes in one application usually compete for the same ports — restarting ' +
        'them one by one in a loop is what calling this avoids.',
      inputSchema: { application_id },
    },
    guard(({ application_id }) => restartApplication(application_id))
  );
}

function registerProcessTools(server) {
  server.registerTool(
    'start_process',
    {
      title: 'Start process',
      description:
        'Start one process of an application. A process already starting or running is a no-op ' +
        'returning its current state, not an error. Status goes to "starting" at once and is ' +
        'promoted to "running" only once it survives the settle window; an exit before that ' +
        'reads "crashed", with lastError quoting its final stderr line.',
      inputSchema: { application_id, process_id },
    },
    guard(({ application_id, process_id }) => startProcess(application_id, process_id))
  );

  server.registerTool(
    'stop_process',
    {
      title: 'Stop process',
      description:
        'Stop one process and everything it spawned: the whole process group is signalled, ' +
        'force-killed after the grace period, and this returns only once the group is confirmed ' +
        'gone — so the port it held is free by the time you get an answer. Already stopped is ' +
        'success.',
      inputSchema: { application_id, process_id },
    },
    guard(({ application_id, process_id }) => stopProcess(application_id, process_id))
  );

  server.registerTool(
    'restart_process',
    {
      title: 'Restart process',
      description:
        'Stop one process, wait for its process group to be gone, then start it again — the ' +
        'call to make after changing code the dev server does not pick up by itself. Restarting ' +
        'a stopped process simply starts it.',
      inputSchema: { application_id, process_id },
    },
    guard(({ application_id, process_id }) => restartProcess(application_id, process_id))
  );
}

function createMcpServer() {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerInspectionTools(server);
  registerApplicationTools(server);
  registerProcessTools(server);
  registerPortTools(server);
  return server;
}

/**
 * Handle one request to `/mcp`. Only POST is spoken here: in stateless mode a GET with
 * `Accept: text/event-stream` opens a standalone SSE stream fed by a keep-alive nothing will ever
 * write to, which leaks the connection (FINDINGS H3).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, -32_000, `${req.method} is not supported: this endpoint is stateless and ` +
      'every MCP message is a POST sent with Accept: application/json, text/event-stream.');
    return;
  }

  const { hosts, origins } = allowlistFor(req.socket.localPort || PORT);
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: hosts,
    allowedOrigins: origins,
  });
  // Both belong to this one request; a transport that outlives its response cannot be reused.
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    // No parsedBody argument — the transport reads the stream itself, and a body consumed here
    // would have to be handed back as that third argument or it answers 400 (FINDINGS H2).
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[paddock] MCP request failed:', formatError(err));
    // A client that hung up mid-request lands here too; there is nobody left to answer.
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) return void res.end();
    rpcError(res, 500, -32_603, 'Internal error while handling the MCP request');
  }
}
