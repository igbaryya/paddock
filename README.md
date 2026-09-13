<div align="center">

<img src="ui/public/favicon.svg" width="72" height="72" alt="">

# Paddock

**Where your local dev environment gets prepped, run up and watched.**

Define an application from several repositories, start the whole thing with one click,
watch every process, and let an AI agent drive it over MCP.

[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.6-5b9cff)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-3ecf8e)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-268%20passing-3ecf8e)](#testing)
[![License](https://img.shields.io/badge/license-MIT-8b94a7)](LICENSE)

<img src="docs/overview.png" alt="The Paddock overview: each application as a card with its processes and the ports they hold">

</div>

---

## Why

Every polyrepo project grows a `run-dev.sh`: the script that launches four dev servers, prefixes
their logs, and leaves something behind on port 3000 when you Ctrl-C it.

Paddock replaces that script with something that actually knows what it started — and then hands the
same controls to an agent, so "the backend died, restart it and tell me what the stack trace said"
stops being your job.

It does not try to understand your code. You define:

```
Application  →  Process  →  repository path
                         →  command
```

It owns configuration, process lifecycle, logs, ports and the MCP surface. The agent brings the
intelligence.

## Quick start

```bash
npm install          # server dependencies
npm run setup        # UI dependencies
npm run build        # build the dashboard
npm start            # http://127.0.0.1:4599
```

No `.env` required — every setting has a default. For UI work with hot reload, `npm run dev` runs the
server and Vite together and tears both down on Ctrl-C.

Then: **New application** → **Add process** → point it at a repository, give it `npm run dev` →
**Start**.

## The dashboard

Three routes, all real URLs — a project page is worth pasting into a ticket, and survives a refresh.

| Route | |
| --- | --- |
| `/` | Every application as a card: status, its processes, the ports it holds |
| `/applications/:id` | One application in full — controls, process detail, live logs |
| `/ports` | Every listening port on the machine, filterable, with its owner |

<img src="docs/application.png" alt="An application page showing three processes, one of them crashed with its error">

Each process shows where it runs from, what it runs, its pid, its uptime, and the ports it ended up
listening on. A crash keeps its exit code and its last stderr line on the row rather than vanishing
into the log scroll.

Application cards carry the favicons of their services beside the name. Once a started process
holds a port, Paddock asks that service for its icon the way a browser does — the `<link rel="icon">`
its page declares, then `/favicon.ico` — and caches the image in the data directory, so the icons
stay after the services stop and across restarts of Paddock. A service with no icon (an API, a
database) simply contributes none.

Adding a process does not mean typing three things out by hand. Both path fields open your operating
system's own folder dialog (falling back to an in-page browser on a machine with no GUI session or,
on Linux, without zenity or kdialog), and once the directory the command will run in is known — the
working directory if you set one, the repository root otherwise — the form offers that directory's `package.json` scripts as the
command, and its `.env` files as the environment. Every one of those is a click, not a default: the
scripts fill the Command field, loading a `.env` adds the variables it does not already have and
leaves the ones you have overridden exactly as you typed them.

## Driving it from an agent

The MCP endpoint is Streamable HTTP at `/mcp`:

```bash
claude mcp add --transport http paddock http://127.0.0.1:4599/mcp
```

<details>
<summary>Client config instead of the CLI</summary>

```json
{
  "mcpServers": {
    "paddock": { "type": "http", "url": "http://127.0.0.1:4599/mcp" }
  }
}
```

</details>

The server binds loopback, so an agent on another machine reaches it through an SSH tunnel or a
private overlay network — not by binding `0.0.0.0`. If a client cannot connect, check it sends
`Accept: application/json, text/event-stream`; the transport answers 406 without both.

### Tools

| | Tool | What it does |
| --- | --- | --- |
| 📋 | `list_applications` | Every application with its rolled-up status and process counts |
| 🔍 | `get_application` | One application: processes, pids, paths, commands, uptime, ports |
| ▶️ | `start_application` | Start every enabled process, in order, with a per-process result |
| ⏹️ | `stop_application` | Stop every process, in reverse order |
| 🔄 | `restart_application` | Stop everything, then start everything |
| ▶️ | `start_process` | Start one process |
| ⏹️ | `stop_process` | Stop one process and its whole group |
| 🔄 | `restart_process` | Restart one process |
| 📜 | `read_logs` | Structured stdout/stderr, per process or application-wide |
| 🔌 | `list_listening_ports` | Every listening TCP port and who owns it |
| 🔎 | `get_port_info` | Everything known about one port |
| ✋ | `stop_port` | Free a port by stopping its current owner |

`read_logs` returns a `next_seq` cursor. Pass it back as `since_seq` to get only what has appeared
since — an agent following a boot does not re-download the history on every poll.

**The agent cannot run arbitrary commands.** Every tool takes ids and port numbers only. There is no
tool that creates, edits or deletes a process, and none that accepts a path or a shell string. An
agent operates what you registered and can free a port; it cannot invent something to run.

<details>
<summary>What that flow looks like</summary>

```
Agent: "why won't the web app start?"

  list_listening_ports        → 5173 is taken, pid 41203, unmanaged, "node …/other-project"
  stop_port(5173)             → stopped, port_released: true
  start_process(app, web)     → running
  read_logs(app, web)         → "VITE ready in 412 ms"
```

</details>

## Processes: what it actually guarantees

This is the part that is easy to fake, so it is worth stating plainly.

- A command runs through `/bin/sh -c` in its **own process group**, so `npm run dev` spawning vite
  spawning esbuild is one killable unit.
- **"Stopped" means the process group is gone**, confirmed by probing it — not that the direct child
  emitted `exit`. A shell wrapper exits in milliseconds while the dev server it launched still holds
  your port; calling that stopped is how a manager starts lying to you.
- Stopping escalates: SIGTERM to the group, SIGKILL to the group if it is still there after the
  grace period.
- The group id is kept until the group is confirmed dead, so **Stop works even on a process already
  considered crashed** — otherwise a half-dead tree would be unkillable from the UI.
- Ctrl-C stops everything it started. `kill -9` cannot be caught, so groups are recorded to
  `runtime.json` and reaped on the next start — but only after re-checking that the group leader
  still matches the recorded command **and** start time, because pids get recycled and killing a
  stranger's process is worse than leaving an orphan.
- stdout and stderr are always consumed. An unread pipe blocks the child at about 192 KB, which
  looks exactly like a hung dev server.

Configuration and runtime state stay apart: `applications.json` holds what you defined; pids,
statuses and uptimes live in memory.

## Ports

<img src="docs/ports.png" alt="The ports page, filtered to processes Paddock manages">

The answer to "why won't this bind?" — and to "what is holding it?".

Correlation is ranked, and the ranking is measured rather than assumed:

| Signal | Confidence |
| --- | --- |
| The listening pid is one Paddock spawned | `exact` |
| The listener is in the **process group** of one it spawned | `exact` |
| An ancestor of the listener is one it spawned | `high` |
| The listener's working directory is inside a configured repository | `medium` |
| A configured repository path appears in the command line | `low` |
| The process name matches | never — there are dozens of `node` processes |

The process-group tier matters more than it looks: a group id is inherited across `fork` and survives
both the shell exiting and the listener being reparented to init — the exact case where walking
parents finds nothing.

**Where it cannot tell, it says so.** A port matched equally well by two configured processes is
reported as ambiguous with both candidates and offered no action. A socket whose owner the OS will
not name is reported as unknown, not as unowned. Neither is guessed at, because the next thing you do
with this information is kill something.

Stopping is routed by ownership: a managed port goes through that process's own stop, so Paddock's
state stays correct; anything else is signalled directly — the single pid, never its group, because
an unmanaged process's group may be your login shell. The pid's identity is re-checked against its
start time and command line before **each** signal, including the forced one. That narrows the
window; it does not close it, and nothing on either platform can.

A dead process is not a free port, so the port is re-resolved afterwards and reported separately.

## Logs

Every process gets a bounded ring buffer (default 2000 lines) serving the dashboard and `read_logs`,
plus an append-only `logs/<applicationId>/<processId>.jsonl` that survives a restart and rotates at a
size cap. Entries carry a sequence number, timestamp, stream and message; ANSI escapes are stripped.
Nothing is kept unbounded in memory.

One sequence counter spans every process, so a single cursor works for one process and for an
application-wide read. A cursor older than the oldest buffered line comes back with `dropped: true`
rather than silently skipping.

## Configuration

| Variable | Default |
| --- | --- |
| `PADDOCK_HOST` | `127.0.0.1` |
| `PADDOCK_PORT` | `4599` |
| `PADDOCK_DATA_DIR` | OS application data directory |
| `PADDOCK_LOG_BUFFER_LINES` | `2000` |
| `PADDOCK_LOG_FILE_MAX_BYTES` | `5242880` |
| `PADDOCK_LOG_PERSIST` | `true` |
| `PADDOCK_STOP_GRACE_MS` | `5000` |
| `PADDOCK_START_SETTLE_MS` | `1500` |
| `PADDOCK_REAP_ORPHANS` | `true` |
| `PADDOCK_PORT_SCAN_TTL_MS` | `3000` |
| `PADDOCK_PORT_SCAN_INTERVAL_MS` | `5000` (0 disables background scanning) |
| `PADDOCK_PORT_STOP_GRACE_MS` | `5000` |
| `PADDOCK_ENV_FILE` | `.env` beside the server |

Data lives in `%APPDATA%\paddock` on Windows, `~/Library/Application Support/paddock` on macOS, and
`$XDG_DATA_HOME/paddock` (else `~/.local/share/paddock`) elsewhere. Nothing is written inside your
repositories.

## Security

Paddock runs commands you configured, from directories you chose, on your machine. That is a
privileged capability, and the boundaries are deliberate:

- Binds loopback, and rejects any request whose `Host` or `Origin` is not a loopback origin, plus any
  connection not from a loopback address. A web page you visit cannot drive your process manager.
- MCP tools take ids and port numbers only — no shell, no paths, no configuration changes.
- A process's working directory must be inside its repository path.
- Favicon discovery only sends requests to ports a scan tied to a managed process with exact or high
  confidence, only over loopback HTTP, and never follows a link or redirect off loopback. Icons reach
  the dashboard as data URLs rendered in `<img>`, never served from Paddock's own origin, so an SVG
  icon cannot run script there.
- Browse opens the OS folder dialog *from the server process* — a browser never gives a page an
  absolute path — which is only sound because the server is loopback-only. It is not an MCP tool.
- The Add-process form can browse the filesystem and read a directory's `package.json` and `.env`.
  The request names a *directory*; which files inside it may be read is the server's decision, never
  the caller's, so there is no path a client can pass that reads an arbitrary file. Loading a `.env`
  copies those values into `applications.json` — treat that file as holding whatever your `.env`
  holds, and it does not track later edits to the `.env` it came from.
- Stopping by port refuses pid 1, Paddock itself and its parent, re-verifies identity before every
  signal, and never group-kills a process it did not start.
- Configured environment variables are never written to logs.

## Platform support

macOS and Linux are the tested path. Port discovery reads `netstat` for completeness — it reports
sockets owned by other users and by root, which a non-root `lsof` silently omits entirely — and
`lsof` for the detail `netstat` truncates.

Windows is implemented against documented behaviour (`netstat -ano`, `Get-CimInstance Win32_Process`,
`taskkill`) but **has not been exercised on a Windows machine**. Two things are weaker there by
nature: no process groups, so a port correlates by ancestry at best and never at `exact`; and a
process's working directory is not readable at all. `taskkill` can report success while the process
is still alive, so termination is always confirmed by polling.

## Testing

```bash
npm test       # 268 tests on node:test — no test framework dependency
npm run check  # syntax gate across every server source
```

The suite covers validation and path containment, atomic writes and corrupt-file recovery, the ring
buffer and its cursors, the HTTP and MCP surfaces, port correlation — and real process lifecycle
against real processes: that stopping frees a grandchild's port, that a SIGTERM-ignoring tree gets
escalated, that concurrent starts spawn exactly one process.

## Architecture

```
             ┌──────────┐        ┌───────────┐
             │ Dashboard│        │   Agent    │
             └────┬─────┘        └─────┬─────┘
            REST + SSE                MCP / HTTP
                  └─────────┬──────────┘
                       service.js          ← the only API boundary
       ┌───────────────┬───────┴───────┬───────────────┐
 applications.js  process-manager.js  ports.js    workspace.js
       │               │               │
   json-db.js      log-store.js    platform/   ← the only OS-aware code
```

- [server.js](server.js) — HTTP server, routing, local-origin guard, startup and shutdown
- [config.js](config.js) — environment, defaults, cross-platform data directory
- [json-db.js](json-db.js) — atomic single-document JSON store
- [applications.js](applications.js) — configuration domain: CRUD and validation
- [process-manager.js](process-manager.js) — spawn, stop, restart, runtime state, orphan reaping
- [log-store.js](log-store.js) — bounded ring buffers and JSONL persistence
- [ports.js](ports.js) — port scan cache, owner correlation, safe termination
- [workspace.js](workspace.js) — read-only project inspection: directory browsing, scripts, `.env`
- [favicons.js](favicons.js) — favicon discovery on running services, and its on-disk cache
- [service.js](service.js) — the facade the UI and MCP both call, and the view models
- [platform/](platform/) — the only code that knows which OS it is on
- [http/](http/) — REST routes, SSE, static serving, MCP tools
- [ui/](ui/) — React + Vite dashboard

The UI never implements process logic. It calls the same `service.js` the MCP tools call, so the
dashboard and an agent can never disagree about what is running.

## License

MIT
