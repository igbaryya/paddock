/**
 * macOS/Linux process control. Every child is spawned detached, so it leads its own process group
 * and `child.pid` is that group's id — the one handle that reaches the whole tree: the shell, the
 * dev server it exec'd, and every worker they forked. A user's `npm run dev` is never a single
 * process, so signalling the direct child alone leaves ports held. Everything here takes a pid the
 * caller owns; nothing above platform/ needs to know any of this exists.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export const platformName = 'posix';

/** `ps` answers instantly or not at all; the bound is only so a wedged host cannot stall us. */
const PS_TIMEOUT_MS = 5_000;

/** A login shell is only ever a startup optimisation, so it gets a hard ceiling and no more. */
const LOGIN_SHELL_TIMEOUT_MS = 10_000;

/**
 * Both small pids are catastrophic as group targets: `kill(0, …)` addresses the caller's own
 * group (the manager), and `kill(-1, …)` addresses every process the user may signal. Neither can
 * ever be a group we spawned, so every entry point refuses them before touching a pid.
 */
const isPid = (pid) => Number.isInteger(pid) && pid > 1;

/** `ps -o lstart=` is fixed format: "Www Mmm dd HH:MM:SS YYYY", then the command to end of line. */
const PS_LINE = /^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/;

/** The same lstart shape, behind pid/ppid/pgid, for the whole-system snapshot. */
const PS_SNAPSHOT_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/**
 * netstat prints the owner as `name:pid` in a column whose position shifts with address width, and
 * it does not escape the name — names really do contain spaces ("Code Helper (Plu"), so no
 * fixed-index parse works. This anchors on both sides instead: the four integer columns that follow
 * LISTEN, and the 5-hex socket state that follows the owner. A name containing a literal
 * `:<digits>` still defeats it, which is why address and port are parsed from the left where the
 * columns are safe, and the owner name is treated as best-effort only.
 */
const NETSTAT_OWNER = /\sLISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+(.+?):(\d+)\s+[0-9a-f]{5}\s/;

/** `tcp4`, `tcp6` and `tcp46` — a `/^tcp[46]/` match silently drops every dual-stack listener. */
const NETSTAT_LISTEN = /^(tcp4|tcp6|tcp46)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN\b/;

/** A scan runs behind a cache but still sits in front of a UI request; it may not hang. */
const SCAN_TIMEOUT_MS = 10_000;

/**
 * `ps -axo args=` on a busy machine, or one process carrying a very long argv, runs past Node's 1 MB
 * default and throws ENOBUFS part-way through a scan.
 */
const SCAN_MAX_BUFFER = 8 * 1024 * 1024;

/** Absolute paths: this manager runs inside arbitrary user repos, where PATH may be anything. */
const LSOF = '/usr/sbin/lsof';
const NETSTAT = '/usr/sbin/netstat';
const PS = '/bin/ps';

/**
 * Exit status 1 means "nothing matched" *and* "not permitted" for every tool here, so a non-zero
 * exit is never on its own an error — only a missing binary is. Returns '' rather than throwing so
 * one blind spot degrades the scan instead of failing it.
 * @param {string} file @param {string[]} args
 */
async function readCommand(file, args) {
  try {
    const { stdout } = await run(file, args, {
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    return typeof err.stdout === 'string' ? err.stdout : '';
  }
}

/** `[::1]:5432` has three colons before the port, and `10.0.0.7:47503` has none. */
const splitHostPort = (value, separator) => {
  const at = value.lastIndexOf(separator);
  if (at < 0) return null;
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  // lsof brackets IPv6 literals; netstat does not. Normalise to the bare address either way.
  return { address: value.slice(0, at).replace(/^\[|\]$/g, ''), port };
};

const familyOf = (proto) => (proto === 'tcp4' ? 'ipv4' : proto === 'tcp6' ? 'ipv6' : 'ipv4+ipv6');

/**
 * netstat is the completeness source: unlike lsof it reports sockets owned by other users and by
 * root without privileges, so it is the only sudo-free way to see that port 443 is taken at all.
 * @param {string} stdout
 */
function parseNetstat(stdout) {
  const listeners = [];
  for (const line of stdout.split('\n')) {
    const row = NETSTAT_LISTEN.exec(line);
    if (!row) continue;
    // netstat separates the port with '.', not ':' — an lsof parser pointed here returns garbage.
    const local = splitHostPort(row[2], '.');
    if (!local) continue;
    const owner = NETSTAT_OWNER.exec(line);
    listeners.push({
      port: local.port,
      protocol: 'tcp',
      address: local.address,
      family: familyOf(row[1]),
      pid: owner ? Number(owner[2]) : null,
      name: owner ? owner[1].trim() : null,
      source: 'netstat',
    });
  }
  return listeners;
}

/**
 * lsof is the detail source: it carries pgid, ppid and the login name in the same pass, and pgid is
 * what makes a managed listener identifiable even after its parent has gone. It sees only our own
 * user's sockets, which is exactly why netstat is read too.
 * @param {string} stdout `-F0` output: NUL-separated fields, one record per line
 */
function parseLsof(stdout) {
  const listeners = [];
  let owner = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const fields = {};
    for (const token of line.split('\0')) if (token) fields[token[0]] = token.slice(1);
    // A `p` record opens a process block; every `f` record after it belongs to that process.
    if (fields.p !== undefined) {
      owner = {
        pid: Number(fields.p),
        pgid: fields.g === undefined ? null : Number(fields.g),
        ppid: fields.R === undefined ? null : Number(fields.R),
        name: fields.c ?? null,
        user: fields.L ?? null,
      };
      continue;
    }
    if (!owner || fields.n === undefined) continue;
    const local = splitHostPort(fields.n, ':');
    if (!local) continue;
    listeners.push({
      port: local.port,
      protocol: 'tcp',
      // lsof renders both 0.0.0.0 and :: as a bare '*'; only the `t` field separates them.
      address: local.address === '*' ? (fields.t === 'IPv6' ? '::' : '0.0.0.0') : local.address,
      family: fields.t === 'IPv6' ? 'ipv6' : 'ipv4',
      pid: owner.pid,
      pgid: owner.pgid,
      ppid: owner.ppid,
      name: owner.name,
      user: owner.user,
      source: 'lsof',
    });
  }
  return listeners;
}

/**
 * Every listening TCP socket the OS will admit to, from both sources at once. Merging is the
 * caller's job: rows from netstat that lsof never saw are precisely the sockets owned by someone
 * else, and saying so is more useful than pretending the port is free.
 * @returns {Promise<{listeners: object[], degraded: string[]}>}
 */
export async function listListeningPorts() {
  const [netstatOut, lsofOut] = await Promise.all([
    readCommand(NETSTAT, ['-anv', '-p', 'tcp']),
    // -b stops lsof stat()ing every mount at startup, which is what makes it hang on a wedged
    // NFS/SMB share during a listener-only scan; -w then silences the warnings -b produces.
    // -n skips DNS (seconds, behind a slow resolver) and -P keeps ports numeric.
    readCommand(LSOF, ['-b', '-w', '-n', '-P', '-iTCP', '-sTCP:LISTEN', '-F0pgRcLtn']),
  ]);
  const listeners = [...parseNetstat(netstatOut), ...parseLsof(lsofOut)];
  const degraded = [];
  if (!netstatOut.trim()) degraded.push('netstat returned nothing — ports owned by other users may be missing');
  if (!lsofOut.trim()) degraded.push('lsof returned nothing — process detail is unavailable');
  return { listeners, degraded };
}

/**
 * One `ps` snapshot for every process, rather than a call per pid: repeated calls cost more beyond a
 * handful of pids and, worse, give a torn view — a parent can exit mid-scan and leave a walk
 * following a pid that has already been reparented.
 * @returns {Promise<Map<number, object>>}
 */
export async function processSnapshot() {
  const stdout = await readCommand(PS, ['-axo', 'pid=,ppid=,pgid=,lstart=,args=']);
  const processes = new Map();
  for (const line of stdout.split('\n')) {
    const row = PS_SNAPSHOT_LINE.exec(line);
    if (!row) continue;
    const pid = Number(row[1]);
    processes.set(pid, {
      pid,
      ppid: Number(row[2]),
      pgid: Number(row[3]),
      startedAt: row[4].trim(),
      // argv[0] as the process presents it: npm rewrites its title to "npm run dev", so this is a
      // description, never a path. The executable is resolved separately and only when asked for.
      commandLine: row[5].trim(),
      name: null,
      executablePath: null,
      workingDirectory: null,
    });
  }
  return processes;
}

/**
 * Working directory, executable and stderr of a pid, in one call — `cwd`, `txt` and fd 2 are just
 * three of the process's open files to lsof. The executable is worth the trouble because
 * `ps -o comm=` is argv[0] as the process chose to present it: npm rewrites its title to
 * "npm run dev", so it is a description and never a path. stderr is how a daemon started with its
 * output redirected (`pg_ctl -l`) says where its log is.
 *
 * lsof exits 1 with no output both for a process with nothing readable and for one we may not
 * inspect, so null here means "could not look" — never "there is none".
 * @param {number} pid
 * @returns {Promise<{workingDirectory: string|null, executablePath: string|null,
 *                    stderrPath: string|null}>}
 */
export async function processPaths(pid) {
  const empty = { workingDirectory: null, executablePath: null, stderrPath: null };
  if (!isPid(pid)) return empty;
  const stdout = await readCommand(LSOF, ['-b', '-w', '-a', '-p', String(pid), '-d', 'cwd,txt,2', '-Ffn']);
  const paths = { ...empty };
  let fd = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('f')) fd = line.slice(1);
    else if (line.startsWith('n') && fd === 'cwd') paths.workingDirectory ??= line.slice(1);
    // A process maps several files as `txt` (the binary, then its shared libraries); the first is
    // the executable itself.
    else if (line.startsWith('n') && fd === 'txt') paths.executablePath ??= line.slice(1);
    // A pipe or a socket is named `->0x…` or `pipe`; only a path is a file someone can open.
    else if (line.startsWith('n/') && fd === '2') paths.stderrPath ??= line.slice(1);
  }
  return paths;
}

/**
 * Signal ONE process, never a group. An unmanaged pid's group may be the user's login shell, so
 * group-killing it would take down their whole terminal session — the opposite of the rule for
 * processes this manager spawned, where the group is the only correct target.
 * @param {number} pid
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{signalled: boolean, reason?: string}>}
 */
export async function signalProcess(pid, { force = false } = {}) {
  if (!isPid(pid)) return { signalled: false, reason: 'invalid-pid' };
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return { signalled: true };
  } catch (err) {
    if (err.code === 'ESRCH') return { signalled: false, reason: 'not-found' };
    if (err.code === 'EPERM') return { signalled: false, reason: 'permission-denied' };
    throw err;
  }
}

/** Does this single pid exist? EPERM means it does and is not ours — never that it is gone. */
export function processExists(pid) {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// --- folder dialog ---------------------------------------------------------------------------

const OSASCRIPT = '/usr/bin/osascript';

/**
 * Arguments arrive through `argv`, never spliced into the source, so a path containing a quote is a
 * path and not a way to run AppleScript. `activate` brings osascript itself to the front — without
 * it the dialog opens behind the browser that asked for it, and it needs no Automation permission
 * because the application it activates is its own.
 */
const CHOOSE_FOLDER = [
  'on run argv',
  'activate',
  'return POSIX path of (choose folder with prompt (item 2 of argv) default location ((item 1 of argv) as POSIX file))',
  'end run',
].flatMap((line) => ['-e', line]);

/** AppleScript reports a cancelled dialog as error -128; zenity and kdialog as exit status 1. */
const cancelledInAppleScript = (err) => /\(-128\)/.test(err.stderr ?? '');
const cancelledByExitStatus = (err) => err.code === 1;

/** zenity and kdialog are X11/Wayland clients; with no display they fail in ways that look like a cancel. */
const hasDisplay = () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * One dialog tool, run to completion. Resolves null when the tool is not on this machine, so the
 * caller can try the next one. A timeout is an abandoned dialog, and is reported as a cancel: the
 * user walked away, nothing failed.
 * @param {string} file @param {string[]} args
 * @param {{timeoutMs: number, isCancel: (err: object) => boolean}} options
 */
async function runDialog(file, args, { timeoutMs, isCancel }) {
  try {
    const { stdout } = await run(file, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const picked = stdout.trim();
    return picked ? { status: 'picked', path: picked } : { status: 'cancelled' };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.killed || isCancel(err)) return { status: 'cancelled' };
    // Most often a manager started over SSH or by launchd, with no GUI session to draw in.
    return { status: 'unavailable', reason: err.stderr?.trim() || err.message };
  }
}

/**
 * Tried in order until one exists: osascript is on every Mac and on no Linux, so no platform branch
 * is needed to pick between them. zenity and kdialog are looked up on PATH rather than pinned to
 * /usr/bin, because Nix and Flatpak installs put them anywhere.
 */
const DIRECTORY_DIALOGS = [
  ({ startAt, prompt, timeoutMs }) =>
    runDialog(OSASCRIPT, [...CHOOSE_FOLDER, startAt, prompt], { timeoutMs, isCancel: cancelledInAppleScript }),
  ({ startAt, prompt, timeoutMs }) =>
    hasDisplay()
      ? runDialog(
          'zenity',
          // The trailing separator is what makes zenity open *inside* the directory, not beside it.
          ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${startAt}/`],
          { timeoutMs, isCancel: cancelledByExitStatus }
        )
      : null,
  ({ startAt, prompt, timeoutMs }) =>
    hasDisplay()
      ? runDialog('kdialog', ['--getexistingdirectory', startAt, '--title', prompt], {
          timeoutMs,
          isCancel: cancelledByExitStatus,
        })
      : null,
];

/**
 * @param {{startAt: string, prompt: string, timeoutMs: number}} request `startAt` must already be
 *   an existing absolute directory — AppleScript refuses a default location that is not one
 * @returns {Promise<{status: 'picked', path: string} | {status: 'cancelled'} |
 *                   {status: 'unavailable', reason: string}>}
 */
export async function pickDirectory(request) {
  for (const dialog of DIRECTORY_DIALOGS) {
    const outcome = await dialog(request);
    if (outcome) return outcome;
  }
  return {
    status: 'unavailable',
    reason: hasDisplay() ? 'no folder dialog found — install zenity or kdialog' : 'no display to open a dialog on',
  };
}

// --- login item ------------------------------------------------------------------------------

const LAUNCHCTL = '/bin/launchctl';

/** launchd is on every Mac and on no Linux — the same test-for-the-tool that picks a folder dialog. */
const hasLaunchd = () => existsSync(LAUNCHCTL);

const launchAgentFile = ({ home, label }) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);

const linuxLauncherFile = ({ launcherDir }) => path.join(launcherDir, 'paddock-login.sh');

function xdgAutostartFile({ home }) {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const base = configured && path.isAbsolute(configured) ? configured : path.join(home, '.config');
  return path.join(base, 'autostart', 'paddock.desktop');
}

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (text) => String(text).replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * The Desktop Entry spec's Exec quoting: a double-quoted argument with `"`, `` ` `` and `$` escaped,
 * `%` doubled because it introduces a field code, and a backslash written four times because the
 * string-value unescaping runs before the quoting rule does.
 */
const desktopExecQuote = (value) =>
  `"${value.replaceAll('\\', '\\\\\\\\').replace(/["`$]/g, '\\$&').replaceAll('%', '%%')}"`;

/**
 * The job a login starts. Each key is here for a reason that is easy to undo by accident:
 *  - the node binary is the absolute path of the one running Paddock now, the one known to work —
 *    launchd's PATH has no nvm or Homebrew in it, so a bare `node` would not be found at all;
 *  - PATH still leads with that node's directory, so the `npm run dev` of a managed service finds npm
 *    even if server.js cannot merge the login shell's PATH, and SHELL is what that merge runs;
 *  - KeepAlive restarts a crash but not a deliberate stop, throttled so a start that keeps failing
 *    (a port held by another Paddock) retries every 30 s rather than every 10;
 *  - ExitTimeOut outlasts Paddock's own 15 s shutdown ceiling, so logout stops services cleanly;
 *  - Interactive, because the dev servers Paddock spawns inherit it and Background throttles I/O.
 */
function launchAgentPlist(spec) {
  const env = {
    ...spec.env,
    SHELL: process.env.SHELL || '/bin/zsh',
    PATH: [path.dirname(spec.program), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  };
  const string = (value) => `<string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by Paddock's Settings screen. Turn it off there, or delete this file. -->",
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(spec.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.program, ...spec.args].map((arg) => `    ${string(arg)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${string(spec.workingDirectory)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>${string(value)}`),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    '  <key>ExitTimeOut</key><integer>30</integer>',
    '  <key>ProcessType</key><string>Interactive</string>',
    `  <key>StandardOutPath</key>${string(spec.logFile)}`,
    `  <key>StandardErrorPath</key>${string(spec.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * A shell launcher rather than everything inline in the desktop entry: Exec cannot redirect output,
 * and its quoting rules are not a shell's. `export` rather than a prefix assignment, because an
 * assignment before `exec` is not guaranteed to reach the program it execs.
 */
function linuxLauncher(spec) {
  return [
    '#!/bin/sh',
    `# Written by Paddock's Settings screen, and run at login by ${xdgAutostartFile(spec)}.`,
    `cd ${shellQuote(spec.workingDirectory)} || exit 1`,
    ...Object.entries(spec.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `exec ${[spec.program, ...spec.args].map(shellQuote).join(' ')} >> ${shellQuote(spec.logFile)} 2>&1`,
    '',
  ].join('\n');
}

const desktopEntry = (launcher) =>
  [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Paddock',
    'Comment=Local development application manager',
    `Exec=${desktopExecQuote(launcher)}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');

/** `writeFile`'s mode only applies to a file it creates, so a rewrite sets it explicitly. */
async function writeEntry(file, content, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
}

/** @returns {Promise<{loaded: boolean, pid: number|null}>} */
async function launchdJob({ label }) {
  try {
    const { stdout } = await run(LAUNCHCTL, ['print', `gui/${process.getuid()}/${label}`], {
      timeout: PS_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const pid = /^\s*pid = (\d+)/m.exec(stdout);
    return { loaded: true, pid: pid ? Number(pid[1]) : null };
  } catch {
    // Exit 113, "could not find service": nothing by that label is loaded in this user's session.
    return { loaded: false, pid: null };
  }
}

/** @param {import('./index.js').LoginItemSpec} spec */
export async function loginItemStatus(spec) {
  if (hasLaunchd()) {
    const location = launchAgentFile(spec);
    return {
      supported: true,
      reason: null,
      note: null,
      installed: existsSync(location),
      location,
      startNowCommand: `launchctl bootstrap gui/${process.getuid()} ${shellQuote(location)}`,
    };
  }
  const location = xdgAutostartFile(spec);
  return {
    supported: true,
    reason: null,
    note: 'Starts with a desktop session (XDG autostart); a login with no desktop, such as over SSH, never runs it.',
    installed: existsSync(location),
    location,
    startNowCommand: null,
  };
}

/** @param {import('./index.js').LoginItemSpec} spec */
export async function installLoginItem(spec) {
  if (hasLaunchd()) {
    await writeEntry(launchAgentFile(spec), launchAgentPlist(spec), 0o644);
    return;
  }
  await writeEntry(linuxLauncherFile(spec), linuxLauncher(spec), 0o755);
  await writeEntry(xdgAutostartFile(spec), desktopEntry(linuxLauncherFile(spec)), 0o644);
}

/** @param {import('./index.js').LoginItemSpec} spec */
export async function removeLoginItem(spec) {
  if (!hasLaunchd()) {
    await fs.rm(xdgAutostartFile(spec), { force: true });
    await fs.rm(linuxLauncherFile(spec), { force: true });
    return;
  }
  await fs.rm(launchAgentFile(spec), { force: true });
  // A job launchd has loaded with nothing running is one stuck retrying a start that keeps failing —
  // on a port another Paddock holds. Unloading it stops nothing and ends the retries now instead of
  // at logout. A job with a pid is a running Paddock, and is left exactly as it is.
  const job = await launchdJob(spec);
  if (job.loaded && job.pid === null) {
    await run(LAUNCHCTL, ['bootout', `gui/${process.getuid()}/${spec.label}`], {
      timeout: PS_TIMEOUT_MS,
    }).catch(() => {});
  }
}

/**
 * The command string is the user's, unparsed — it may contain `&&`, pipes, globs and env
 * prefixes, which only a shell gets right.
 * @param {string} command
 */
export const shellInvocation = (command) => ({ file: '/bin/sh', args: ['-c', command] });

/**
 * `detached: true` makes libuv call setsid(), which is what gives the child its own group and makes
 * `child.pid === pgid`. cwd/env are the caller's to pass to spawn; this layer adds nothing to them.
 */
export const spawnOptions = () => ({ detached: true });

/**
 * @param {number} pid process group leader
 * @param {{force?: boolean}} [options] force sends SIGKILL instead of SIGTERM
 */
export async function signalTree(pid, { force = false } = {}) {
  if (!isPid(pid)) return;
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    // ESRCH is the goal state, reached early. EPERM is a real failure and must reach the caller.
    if (err.code !== 'ESRCH') throw err;
  }
}

/** Last resort from `process.on('exit')`, where async work is dropped and a throw goes nowhere. */
export function killTreeSync(pid) {
  if (!isPid(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone, or never ours — either way there is nothing left to do at exit.
  }
}

/** @param {number} pid process group leader */
export function treeAlive(pid) {
  if (!isPid(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // EPERM means the group exists but is not ours to signal — alive. Only ESRCH means gone.
    return err.code === 'EPERM';
  }
}

/**
 * Identity fingerprint of a group leader. Pids are recycled, so the orphan reaper compares both the
 * start time and the command before killing a pgid it recorded in a previous run.
 * @param {number} pid
 * @returns {Promise<{startedAt: string, command: string}|null>} null when gone or unreadable
 */
export async function describeLeader(pid) {
  if (!isPid(pid)) return null;
  try {
    // `-ww` removes the width limit: procps truncates `command=` to the screen width otherwise, and
    // a fingerprint that changes with the terminal is one the reaper can never match twice.
    const { stdout } = await run('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], {
      timeout: PS_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const match = PS_LINE.exec(stdout.trim());
    // An unparseable line means we cannot prove identity, and an unproven pid must not be killed.
    if (!match) return null;
    return { startedAt: match[1].trim(), command: match[2].trim() };
  } catch {
    return null;
  }
}

/**
 * The user's real PATH, for a manager started by launchd/Finder with a minimal environment where
 * nvm and homebrew are missing and every `npm run dev` fails. It must be `-ilc`: nvm lives in
 * ~/.zshrc and an interactive shell is the only one that reads it.
 * @param {number} timeoutMs
 * @returns {Promise<string|null>} null on any failure — an optimisation, never a hard error
 */
export async function loginShellPath(timeoutMs) {
  const shell = process.env.SHELL?.trim();
  if (!shell) return null;
  // An unusable timeout must not become "no timeout": an interactive shell is exactly the kind of
  // child that can sit forever, and this runs on the startup path before the server listens.
  const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LOGIN_SHELL_TIMEOUT_MS;
  try {
    const { stdout } = await run(shell, ['-ilc', 'command printf "%s" "$PATH"'], {
      timeout: bound,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      // `-i` gates rc sourcing on the interactive flag, not on a tty, so closing stdin still picks
      // up nvm — and it stops a shell that reads stdin from blocking until the timeout fires.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Interactive rc files chatter on stdout; printf writes no newline, so PATH is the last line.
    const value = stdout.split('\n').pop().trim();
    return value.includes('/') ? value : null;
  } catch {
    return null;
  }
}
