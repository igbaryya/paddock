/**
 * Start Paddock at login — the Settings screen's switch. The OS entry itself is written by platform/;
 * this module decides what that entry runs, and keeps a record of what it wrote so the screen can
 * tell an entry that still works from one that has gone stale.
 *
 * The record is needed because an entry outlives what it points at. The checkout moves, or nvm drops
 * the node version it names, and the entry keeps "starting" something that is no longer there — at a
 * login where nobody is watching for the failure. Comparing the record with this running copy is
 * how the screen finds that out while someone is.
 *
 * Deliberately not reachable over MCP: an agent has no business deciding what runs when the user
 * logs in.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, LOG_DIR, ROOT_DIR } from './config.js';
import * as platform from './platform/index.js';

/** The launchd label, and the name the entry goes by elsewhere. Matches the agent set up by hand. */
const LABEL = 'local.paddock';

const RECORD_FILE = path.join(DATA_DIR, 'login-item.json');

/**
 * Set in the entry's environment, which is how a running copy knows a login started it. The desktop
 * app sets it on the server it forks when a login opened the app.
 */
const LOGIN_ITEM_ENV = 'PADDOCK_LOGIN_ITEM';

/**
 * Set by the desktop app on the server it forks: the app's own executable. There `process.execPath`
 * is Electron's helper, which a login must not start — the app is what the entry opens.
 */
const DESKTOP_APP_ENV = 'PADDOCK_DESKTOP_APP';

/**
 * What the entry runs: this checkout, under the node binary running it right now — the one proven to
 * work with it. A version manager's alias would follow upgrades, but it would also silently pick a
 * node this checkout has never run on; a pinned path that goes missing is caught by `problemsOf`.
 * Under the desktop app, the app itself, which starts this server on its own.
 * @param {string} [desktopApp]
 */
const launchCommand = (desktopApp) =>
  desktopApp
    ? { program: desktopApp, args: [] }
    : { program: process.execPath, args: [path.join(ROOT_DIR, 'server.js')] };

/** @returns {import('./platform/index.js').LoginItemSpec} */
const currentSpec = () => ({
  label: LABEL,
  home: os.homedir(),
  ...launchCommand(process.env[DESKTOP_APP_ENV]),
  workingDirectory: ROOT_DIR,
  logFile: path.join(LOG_DIR, 'paddock.log'),
  launcherDir: DATA_DIR,
  env: { [LOGIN_ITEM_ENV]: '1' },
});

const isRecord = (value) =>
  typeof value?.program === 'string' &&
  Array.isArray(value.args) &&
  typeof value.workingDirectory === 'string' &&
  typeof value.writtenAt === 'string';

/** A missing, torn or hand-edited record reads as "no record" — `problemsOf` says what that means. */
async function readRecord() {
  try {
    const record = JSON.parse(await fs.readFile(RECORD_FILE, 'utf8'));
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Why an installed entry will not start this copy of Paddock at the next login. Pure, so every case
 * is testable without an OS entry existing at all.
 * @param {{installed: boolean, record: object|null, spec: object, programExists: boolean}} facts
 * @returns {string[]} empty when there is nothing to fix
 */
export function problemsOf({ installed, record, spec, programExists }) {
  if (!installed) return [];
  if (!record) {
    return ['This entry was not written by Paddock, so what it starts is unknown.'];
  }
  const problems = [];
  if (record.workingDirectory !== spec.workingDirectory) {
    problems.push(`It starts the copy of Paddock at ${record.workingDirectory}, not this one.`);
  }
  if (!programExists) {
    problems.push(`It runs ${record.program}, which no longer exists.`);
  }
  return problems;
}

/**
 * Everything the Settings screen shows about the switch.
 * @returns {Promise<object>}
 */
export async function status() {
  const spec = currentSpec();
  const [entry, record] = await Promise.all([platform.loginItemStatus(spec), readRecord()]);
  const installed = entry.supported && entry.installed;
  return {
    ...entry,
    enabled: installed,
    // What the entry was written to run, not what it would be written to run today.
    runs:
      installed && record
        ? { program: record.program, args: record.args, workingDirectory: record.workingDirectory }
        : null,
    logFile: spec.logFile,
    launchedAtLogin: process.env[LOGIN_ITEM_ENV] === '1',
    problems: problemsOf({
      installed,
      record,
      spec,
      programExists: record ? existsSync(record.program) : false,
    }),
  };
}

/**
 * Write the entry for this copy, replacing whatever entry is there — which is also how a stale one
 * is repaired. Never starts anything now: see `platform.installLoginItem`.
 */
export async function enable() {
  const spec = currentSpec();
  // launchd will not create the directory of a log path, and a job whose log cannot be opened fails
  // before Paddock prints a word about why.
  await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
  await platform.installLoginItem(spec);
  const record = {
    program: spec.program,
    args: spec.args,
    workingDirectory: spec.workingDirectory,
    writtenAt: new Date().toISOString(),
  };
  await fs.writeFile(RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return status();
}

/** Remove the entry. The running copy keeps running, whatever started it. */
export async function disable() {
  await platform.removeLoginItem(currentSpec());
  await fs.rm(RECORD_FILE, { force: true });
  return status();
}
