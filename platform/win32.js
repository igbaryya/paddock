/**
 * Windows process control. There are no process groups here, so a tree is reached through
 * `taskkill /T`, which walks the parent/child chain itself, and liveness is read back from
 * `tasklist`. Every pid is validated and passed in an argv array — never interpolated into a
 * shell string. Console tools write in the OEM code page rather than UTF-8, so their output is
 * decoded byte-preserving and only ever compared against strings this module produced.
 */
import { execFile, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export const platformName = 'win32';

/** These are local queries; the bound exists so a hung console host cannot stall a stop. */
const PROBE_TIMEOUT_MS = 5_000;

const isPid = (pid) => Number.isInteger(pid) && pid > 0;

/**
 * latin1 maps every byte to a character and never throws, so a non-UTF-8 code page cannot corrupt
 * the result or lose the ASCII we actually match on.
 */
const decodeConsole = (buffer) => (buffer ? Buffer.from(buffer).toString('latin1') : '');

const taskkillArgs = (pid, force) => {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  return args;
};

/** `/d` skips AutoRun commands, `/s` keeps the rest of the line intact for the user's quotes. */
export const shellInvocation = (command) => ({
  file: process.env.ComSpec || 'cmd.exe',
  args: ['/d', '/s', '/c', command],
});

/** No process groups to create; the only thing worth suppressing is a console window flash. */
export const spawnOptions = () => ({ windowsHide: true });

/**
 * @param {number} pid tree root
 * @param {{force?: boolean}} [options] force adds /F, which terminates instead of asking
 */
export async function signalTree(pid, { force = false } = {}) {
  if (!isPid(pid)) return;
  try {
    const opts = { timeout: PROBE_TIMEOUT_MS, encoding: 'buffer', windowsHide: true };
    await run('taskkill', taskkillArgs(pid, force), opts);
  } catch {
    // taskkill's exit codes and messages are localised; `treeAlive` is the authority on whether the
    // tree is gone, so a failure here is never reported as one.
  }
}

/** Last resort from `process.on('exit')`: spawnSync reports failures on its result, not throws. */
export function killTreeSync(pid) {
  if (!isPid(pid)) return;
  try {
    spawnSync('taskkill', taskkillArgs(pid, true), {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'buffer',
      windowsHide: true,
    });
  } catch {
    // spawnSync reports a missing binary on its result, but still throws on a malformed spawn.
    // Nothing at exit time can act on either, and a throw here would mask the real exit path.
  }
}

/** Narrower than the tree, but a real answer — used only when tasklist itself cannot be run. */
const leaderAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** @param {number} pid tree root */
export function treeAlive(pid) {
  if (!isPid(pid)) return false;
  let result;
  try {
    result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'buffer',
      windowsHide: true,
    });
  } catch {
    return leaderAlive(pid);
  }
  if (result.error || result.status !== 0) return leaderAlive(pid);
  // No match prints an "INFO:" line and still exits 0, so the pid's presence is the real signal.
  return decodeConsole(result.stdout).includes(String(pid));
}

/**
 * Identity fingerprint of a pid, so the orphan reaper can tell a leftover from a recycled pid.
 * PowerShell is the query path because wmic is absent from current Windows versions.
 * @param {number} pid
 * @returns {Promise<{startedAt: string, command: string}|null>} null when gone or unreadable
 */
export async function describeLeader(pid) {
  if (!isPid(pid)) return null;
  // `[Console]::Out.Write` bypasses PowerShell's formatter, which hard-wraps a written string at
  // the console width — a long command line would otherwise come back with newlines in it and
  // never match the recorded fingerprint. One tab separates two fields that cannot contain one.
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    "if ($p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o') + [char]9 + " +
    '$p.CommandLine) }';
  try {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const { stdout } = await run('powershell', args, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'buffer',
    });
    const line = decodeConsole(stdout);
    const separator = line.indexOf('\t');
    if (separator === -1) return null;
    const startedAt = line.slice(0, separator).trim();
    const command = line.slice(separator + 1).trim();
    // Both halves must be readable: a pid we cannot prove the identity of must not be killed.
    if (!startedAt || !command) return null;
    return { startedAt, command };
  } catch {
    return null;
  }
}

/**
 * Windows builds a process's environment from the registry and the parent, not from a login shell,
 * so there is no minimal-PATH case to repair here.
 * @returns {Promise<null>}
 */
export async function loginShellPath() {
  return null;
}

/** A scan sits in front of a UI request even behind a cache, so it may not hang. */
const SCAN_TIMEOUT_MS = 10_000;

const SCAN_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * PATH search on Windows can include the current directory, and this manager runs inside arbitrary
 * user repositories — a checked-in `netstat.bat` would otherwise be executed instead.
 */
const system32 = (exe) => `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\${exe}`;

const POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * Console tools exit non-zero for "nothing matched" as readily as for a real failure, so output is
 * taken wherever it exists and a failure degrades the scan rather than ending it.
 * @param {string} file @param {string[]} args
 */
async function readCommand(file, args) {
  try {
    const { stdout } = await run(file, args, {
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      encoding: 'buffer',
      windowsHide: true,
    });
    return decodeConsole(stdout);
  } catch (err) {
    return decodeConsole(err.stdout);
  }
}

/** `[::]:3000` and `127.0.0.1:3000` — the port is always after the last colon. */
const splitHostPort = (value) => {
  const at = value.lastIndexOf(':');
  if (at < 0) return null;
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: value.slice(0, at).replace(/^\[|\]$/g, ''), port };
};

/**
 * Every listening TCP socket, from `netstat -ano`. The `-p TCP` filter is deliberately omitted: tcp
 * and tcpv6 are separate values to that flag, and Node's `listen(port)` binds dual-stack `[::]`, so
 * filtering by protocol is the fastest way to make a running dev server invisible. `-b` would name
 * the executable but requires elevation, so the pid is resolved to a name separately.
 * @returns {Promise<{listeners: object[], degraded: string[]}>}
 */
export async function listListeningPorts() {
  const stdout = await readCommand(system32('netstat.exe'), ['-ano']);
  const listeners = [];
  for (const line of stdout.split(/\r?\n/)) {
    // Banner and column headers are localised, so rows are identified structurally: a TCP row is
    // five whitespace-separated tokens ending in a pid, never by matching "Proto" or "Active".
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== 5) continue;
    const [proto, local, , state, pid] = tokens;
    if (proto.toUpperCase() !== 'TCP' || state.toUpperCase() !== 'LISTENING') continue;
    if (!/^\d+$/.test(pid)) continue;
    const parsed = splitHostPort(local);
    if (!parsed) continue;
    listeners.push({
      port: parsed.port,
      protocol: 'tcp',
      address: parsed.address,
      // `[::]` is dual-stack here — a v4 client reaches it, so reporting it as v6-only would be a
      // lie the UI would repeat back as "not listening on IPv4".
      family: parsed.address === '::' ? 'ipv4+ipv6' : parsed.address.includes(':') ? 'ipv6' : 'ipv4',
      pid: Number(pid),
      name: null,
      source: 'netstat',
    });
  }
  const degraded = listeners.length === 0 && !stdout.trim() ? ['netstat returned nothing'] : [];
  return { listeners, degraded };
}

/**
 * Process detail for the whole machine in one PowerShell call. The result comes back as base64 of
 * UTF-8 JSON: the console code page is not UTF-8 and Node cannot decode OEM 437/850 at all, while
 * setting `[Console]::OutputEncoding` would mutate the shared console and corrupt the user's own
 * terminal for the rest of the session.
 * @returns {Promise<Map<number, object>>}
 */
export async function processSnapshot() {
  // `@(...)` forces array semantics — ConvertTo-Json on a single object emits an object, and
  // -AsArray does not exist in Windows PowerShell 5.1. The projection to a flat object matters too:
  // a raw CimInstance drags in CimClass/CimSystemProperties and blows past the default -Depth.
  const script =
    '$r = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ' +
    'pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; ' +
    'exe = $_.ExecutablePath; cmd = $_.CommandLine; ' +
    "started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } }); " +
    '[Console]::Out.Write([Convert]::ToBase64String(' +
    '[Text.Encoding]::UTF8.GetBytes(($r | ConvertTo-Json -Compress -Depth 3))))';
  const encoded = await readCommand(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script]);
  const processes = new Map();
  if (!encoded.trim()) return processes;
  let rows;
  try {
    rows = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'));
  } catch {
    // A Constrained Language Mode or AppLocker policy can break the script itself; the port list
    // still works without detail, so this degrades rather than failing the scan.
    return processes;
  }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (!Number.isInteger(row?.pid)) continue;
    processes.set(row.pid, {
      pid: row.pid,
      ppid: Number.isInteger(row.ppid) ? row.ppid : null,
      // There are no process groups on Windows, so the strongest POSIX correlation signal simply
      // does not exist here and correlation falls back to ancestry.
      pgid: null,
      startedAt: row.started ?? null,
      // Both come back null for another user's or an elevated process without SeDebugPrivilege.
      commandLine: row.cmd ?? null,
      executablePath: row.exe ?? null,
      name: row.name ?? null,
      workingDirectory: null,
    });
  }
  return processes;
}

/**
 * Windows does not expose a process's working directory to another process without a debugger, so
 * it is always null here — the correlation layer treats that as "could not look", not "no cwd".
 * The executable path is already carried by the snapshot, from Win32_Process.
 * @returns {Promise<{workingDirectory: null, executablePath: null}>}
 */
export async function processPaths() {
  return { workingDirectory: null, executablePath: null, stderrPath: null };
}

/**
 * Terminate ONE process, without `/T`: an unmanaged pid's children are not ours to take down, and
 * on Windows `/T` resolves them by parent id at call time anyway, which strands grandchildren whose
 * intermediate has already exited.
 * @param {number} pid
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{signalled: boolean, reason?: string}>}
 */
export async function signalProcess(pid, { force = false } = {}) {
  if (!isPid(pid)) return { signalled: false, reason: 'invalid-pid' };
  const args = force ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)];
  try {
    await run(system32('taskkill.exe'), args, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'buffer',
      windowsHide: true,
    });
    // taskkill can exit 0 having only *asked* a process to close, so success here is a request
    // that was accepted — the caller confirms death by polling, never by trusting this.
    return { signalled: true };
  } catch (err) {
    // Exit codes are undocumented and every message is localised, so the status is all there is:
    // 128 is "no such process", and anything else on a live pid is treated as a refusal.
    if (err.code === 128) return { signalled: false, reason: 'not-found' };
    return { signalled: false, reason: processExists(pid) ? 'permission-denied' : 'not-found' };
  }
}

/** Does this single pid exist? EPERM means it does and is not ours — never that it is gone. */
export function processExists(pid) {
  if (!isPid(pid)) return false;
  return leaderAlive(pid);
}

// --- login item ------------------------------------------------------------------------------

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Paddock';

const launcherFile = ({ launcherDir }) => path.join(launcherDir, 'paddock-login.vbs');

/** A VBScript string literal, in which a quote is written twice. */
const vbsString = (text) => `"${String(text).replaceAll('"', '""')}"`;

/**
 * A console program started from the Run key gets a console window for the whole session. wscript
 * running this with window style 0 is the dependable way to start one without it. `cmd /s /c` is only
 * there for the log redirection: with /s it strips exactly the outer pair of quotes and runs the rest
 * verbatim, which is what lets every path inside keep quotes of its own.
 */
function launcherScript(spec) {
  const command = [spec.program, ...spec.args].map((part) => `"${part}"`).join(' ');
  const commandLine = `cmd /d /s /c "${command} >> "${spec.logFile}" 2>&1"`;
  return [
    "' Written by Paddock's Settings screen: starts Paddock at login, with no console window.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(spec.workingDirectory)}`,
    ...Object.entries(spec.env).map(
      ([key, value]) => `shell.Environment("PROCESS")(${vbsString(key)}) = ${vbsString(value)}`
    ),
    `shell.Run ${vbsString(commandLine)}, 0, False`,
    '',
  ].join('\r\n');
}

const regOptions = { timeout: PROBE_TIMEOUT_MS, encoding: 'buffer', windowsHide: true };

/** @param {import('./index.js').LoginItemSpec} spec */
export async function loginItemStatus(spec) {
  const installed = await run(system32('reg.exe'), ['query', RUN_KEY, '/v', RUN_VALUE], regOptions).then(
    () => true,
    () => false
  );
  return {
    supported: true,
    reason: null,
    note: null,
    installed,
    location: `${RUN_KEY}\\${RUN_VALUE}`,
    startNowCommand: `wscript.exe //B //NoLogo "${launcherFile(spec)}"`,
  };
}

/** @param {import('./index.js').LoginItemSpec} spec */
export async function installLoginItem(spec) {
  const launcher = launcherFile(spec);
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, launcherScript(spec));
  const value = `"${system32('wscript.exe')}" //B //NoLogo "${launcher}"`;
  await run(system32('reg.exe'), ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'], regOptions);
}

/** @param {import('./index.js').LoginItemSpec} spec */
export async function removeLoginItem(spec) {
  // Deleting a value that is not there exits non-zero, and "already off" is the state asked for.
  await run(system32('reg.exe'), ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], regOptions).catch(() => {});
  await fs.rm(launcherFile(spec), { force: true });
}

/**
 * The folder dialog, from WinForms. Both inputs travel as environment variables rather than being
 * spliced into the script, so a path with a quote in it cannot become PowerShell. `-STA` is required:
 * a WinForms dialog on an MTA thread throws before it draws. The invisible TopMost owner is what
 * stops the dialog opening behind the browser that asked for it. The answer comes back as base64 of
 * UTF-8 for the same code-page reason as `processSnapshot`.
 */
const CHOOSE_FOLDER = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:PADDOCK_PICK_PROMPT',
  '$dialog.SelectedPath = $env:PADDOCK_PICK_START',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))',
  '}',
].join('\n');

/**
 * @param {{startAt: string, prompt: string, timeoutMs: number}} request
 * @returns {Promise<{status: 'picked', path: string} | {status: 'cancelled'} |
 *                   {status: 'unavailable', reason: string}>}
 */
export async function pickDirectory({ startAt, prompt, timeoutMs }) {
  try {
    const { stdout } = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-Command', CHOOSE_FOLDER], {
      timeout: timeoutMs,
      encoding: 'buffer',
      windowsHide: true,
      env: { ...process.env, PADDOCK_PICK_START: startAt, PADDOCK_PICK_PROMPT: prompt },
    });
    const encoded = decodeConsole(stdout).trim();
    if (!encoded) return { status: 'cancelled' };
    return { status: 'picked', path: Buffer.from(encoded, 'base64').toString('utf8') };
  } catch (err) {
    // An abandoned dialog is a cancel. Anything else is most often a manager running as a service
    // in session 0, where there is no desktop for a dialog to appear on.
    if (err.killed) return { status: 'cancelled' };
    return { status: 'unavailable', reason: decodeConsole(err.stderr).trim() || err.message };
  }
}
