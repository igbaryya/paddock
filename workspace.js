/**
 * Read-only inspection of the user's project directories, for the process form: the OS folder dialog
 * that chooses one, which directories live under a path when there is no dialog to show, which
 * package.json scripts a directory offers, and what its .env files already set. Nothing here is
 * configuration and nothing here is cached — every answer is what the disk says at the moment it is
 * asked.
 *
 * The caller names a directory and never a file. Which files inside it may be read is decided here,
 * which is what keeps a browse endpoint from becoming a way to read any file on the machine. It does
 * mean a .env's values reach the browser — that is the feature, and it is the reason this module
 * reads nothing it was not asked for.
 *
 * Every read is bounded. A directory with a hundred thousand entries, a package.json that is really
 * a bundle and a .env that is really a core dump all have to answer without taking the manager down
 * with them, so each limit below caps one answer rather than promising anything about the disk.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ENV_KEY_PATTERN,
  ValidationError,
  assertAbsolutePath,
  assertDirectory,
} from './applications.js';
import * as platform from './platform/index.js';

/** Directories in one browse. The picker filters as you type, so a complete listing is not the point. */
const MAX_ENTRIES = 500;

/** A folder dialog left open this long was walked away from; it is closed and reported as a cancel. */
const PICK_TIMEOUT_MS = 10 * 60_000;

const PICK_PROMPT = 'Choose a folder';

/** A symlinked child costs a stat to classify, so only this many are resolved per browse. */
const MAX_SYMLINK_STATS = 100;

const MAX_PACKAGE_BYTES = 1_048_576;
const MAX_SCRIPTS = 100;
const MAX_ENV_FILES = 10;
const MAX_ENV_BYTES = 262_144;
const MAX_ENV_VARIABLES = 200;

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Lockfile → package manager, in the order a repository carrying more than one should be read: a
 * stray package-lock.json in a pnpm repository is far commoner than the reverse.
 */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `<manager> run <script>` for every manager, npm included. The shorthands (`yarn dev`, `pnpm dev`)
 * break on a script whose name collides with a built-in subcommand; the long form never does.
 */
const runCommand = (manager, script) => `${manager} run ${script}`;

/** `assertDirectory` proves a directory is there; it does not prove this process may list it. */
const unreadable = (dir) => (err) => {
  throw new ValidationError(`path '${dir}' cannot be listed (${err.code ?? err.message})`);
};

/**
 * Resolved and checked with the same two helpers `addProcess` uses, so the picker can never offer a
 * directory the save that follows would refuse.
 *
 * The resolved path is returned rather than the realpath `assertDirectory` hands back: browsing
 * through a symlink must not silently relocate the user to its target, and containment inside the
 * repository root is re-checked when the process is actually saved.
 */
function resolveDirectory(requested) {
  const resolved = assertAbsolutePath(requested, 'path');
  assertDirectory(resolved, 'path');
  return resolved;
}

/** The picker has to open somewhere, and a form with an empty path field names no directory at all. */
function requestedOrHome(requested) {
  const unset =
    requested === undefined ||
    requested === null ||
    (typeof requested === 'string' && requested.trim() === '');
  return unset ? homedir() : resolveDirectory(requested);
}

/** A broken or unreadable link is not a directory the picker can offer, so it is simply not one. */
const isDirectory = (target) => stat(target).then((info) => info.isDirectory(), () => false);

/**
 * A dirent classifies a symlink as a symlink and never as what it points at, and a project reached
 * through one is exactly the case a picker has to handle. Only the symlinks cost a stat, and only
 * the first `MAX_SYMLINK_STATS` of them — past that they are dropped rather than allowed to turn
 * one browse into thousands of syscalls.
 */
async function directoryNames(found, dir) {
  const direct = found.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const links = found.filter((entry) => entry.isSymbolicLink()).slice(0, MAX_SYMLINK_STATS);
  const resolved = await Promise.all(links.map((link) => isDirectory(path.join(dir, link.name))));
  return [...direct, ...links.filter((_, index) => resolved[index]).map((link) => link.name)];
}

/**
 * The directories directly under `dir`, plus the one above it — everything the picker needs to move
 * in either direction. Files are left out: a process is configured with a directory, so offering
 * files would only be a way to pick something invalid.
 * @param {string} [requested] absolute path; unset opens at the user's home directory
 * @returns {Promise<{path: string, parent: string|null, entries: {name: string, path: string}[],
 *                    truncated: boolean}>}
 */
export async function listDirectory(requested) {
  const dir = requestedOrHome(requested);
  const found = await readdir(dir, { withFileTypes: true }).catch(unreadable(dir));
  const names = await directoryNames(found, dir);
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    // dirname('/') is '/' and dirname('C:\\') is 'C:\\': equality is how the root announces itself.
    parent: parent === dir ? null : parent,
    entries: names.slice(0, MAX_ENTRIES).map((name) => ({ name, path: path.join(dir, name) })),
    truncated: names.length > MAX_ENTRIES,
  };
}

/** Whether a folder dialog is on screen right now. There is one screen, so there is one dialog. */
let picking = false;

/** A half-typed or since-deleted path is a reason to open the dialog at home, never to refuse to open it. */
function dialogStart(requested) {
  try {
    return requestedOrHome(requested);
  } catch {
    return homedir();
  }
}

/**
 * The operating system's own folder dialog. A browser can open one too, but by design it never hands
 * the page an absolute path — only a folder name — so the dialog is opened here, on the machine the
 * manager runs on, which the loopback-only server guarantees is the machine the browser is on.
 *
 * A second request while a dialog is open is refused rather than joined: joining would write the one
 * folder the user picks into whichever other field also asked.
 *
 * Not exposed over MCP, and it should stay that way — an agent has no business putting a modal
 * dialog in front of the person at the keyboard.
 * @param {string} [startAt] where the dialog opens; anything unusable opens it at home
 * @returns {Promise<{status: 'picked', path: string} | {status: 'cancelled'} |
 *                   {status: 'unavailable', reason: string}>}
 */
export async function pickDirectory(startAt) {
  if (picking) {
    throw new ValidationError('A folder dialog is already open — choose or cancel in that one first');
  }
  picking = true;
  try {
    const outcome = await platform.pickDirectory({
      startAt: dialogStart(startAt),
      prompt: PICK_PROMPT,
      timeoutMs: PICK_TIMEOUT_MS,
    });
    // macOS answers with a trailing separator; resolving here is what makes it the same string the
    // save path would store.
    return outcome.status === 'picked' ? { status: 'picked', path: resolveDirectory(outcome.path) } : outcome;
  } finally {
    picking = false;
  }
}

/**
 * A bounded read. The size check is the point: these are paths the user pointed at rather than paths
 * this manager chose, and `.env` is a name a multi-gigabyte file is perfectly free to have.
 * @returns {Promise<string>}
 */
async function readBounded(file, limit) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  if (info.size > limit) throw new Error(`${path.basename(file)} is larger than ${limit} bytes`);
  return readFile(file, 'utf8');
}

/** Corepack's `packageManager: "pnpm@9.1.0"` names the manager; the version is not our business. */
function declaredManager(value) {
  const name = typeof value === 'string' ? value.split('@')[0].trim() : '';
  return MANAGERS.has(name) ? name : null;
}

const lockfileManager = (names) => LOCKFILES.find(([file]) => names.includes(file))?.[1] ?? null;

/**
 * Corepack's `packageManager` field is a declaration and wins; a lockfile is evidence; npm is the
 * assumption a package.json with neither has earned. Null when there is no package.json at all,
 * which is how the form knows it has no command to suggest.
 */
const packageManagerOf = (pkg, names) => (pkg ? pkg.manager ?? lockfileManager(names) ?? 'npm' : null);

/**
 * A package.json that will not read or will not parse is not something the user has to fix before
 * they can pick a directory — they may not even own it — so it reads as "no scripts here" and the
 * form stays quiet about it.
 */
async function readPackage(dir) {
  let parsed;
  try {
    parsed = JSON.parse(await readBounded(path.join(dir, 'package.json'), MAX_PACKAGE_BYTES));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    manager: declaredManager(parsed.packageManager),
    scripts: isObject(parsed.scripts) ? parsed.scripts : {},
  };
}

/** What a process manager is being pointed at, nine times out of ten. */
const scriptRank = (name) => (name === 'dev' ? 0 : name === 'start' ? 1 : 2);

/**
 * Every script the package declares. The sort is by that rank alone and `Array.prototype.sort` is
 * specified to be stable, so everything else keeps the order its author wrote it in — a better guide
 * to what matters in a repository than any alphabet.
 */
function scriptSuggestions(scripts, manager) {
  return Object.entries(scripts)
    .filter(([name, script]) => name && typeof script === 'string')
    .slice(0, MAX_SCRIPTS)
    .map(([name, script]) => ({ name, script, command: runCommand(manager, name) }))
    .sort((a, b) => scriptRank(a.name) - scriptRank(b.name));
}

const isEnvFileName = (name) => name === '.env' || name.startsWith('.env.');

/**
 * `.env` first, then the rest alphabetically — the form offers them in this order and points at the
 * first. `.env.example` is included deliberately: it is a list of the names a repository expects,
 * which is exactly what someone filling this form in wants to see.
 */
const envFileNames = (names) =>
  names
    .filter(isEnvFileName)
    .sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)))
    .slice(0, MAX_ENV_FILES);

/**
 * One `KEY=value` assignment, matched over the whole file rather than line by line, because a quoted
 * value is allowed to span lines. The value alternatives are tried in order: single-, double- and
 * backtick-quoted, then everything up to a `#` or the end of the line. `export ` is accepted because
 * a .env is so often sourced by a shell as well as read by a loader.
 *
 * Every gap in it is `[^\S\r\n]*` — whitespace that is *not* a line break — and not `\s*`. A plain
 * `\s*` after the `=` reads `EMPTY=` followed by `NEXT=value` as one assignment of `NEXT=value` to
 * `EMPTY`, because it is free to cross the newline in search of something to call a value. An empty
 * assignment is the commonest line in a .env.example there is.
 *
 * Names are matched loosely and filtered afterwards: `foo.bar=1` is an assignment this manager
 * cannot turn into a variable, and saying so is more use than not matching the line at all.
 */
const ASSIGNMENT =
  /^[^\S\r\n]*(?:export[^\S\r\n]+)?([\w.-]+)[^\S\r\n]*=[^\S\r\n]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)/gm;

const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Strip the quotes the value was written with, and expand the escapes only a double-quoted value
 * has. Two deliberate matches with how dotenv itself reads these files, because the value shown in
 * the form has to be the value the application will actually get:
 *
 *  - no `${VAR}` interpolation — and a reference resolved against the *manager's* environment would
 *    in any case be filling in the wrong machine's value;
 *  - an unquoted value ends at the first `#`, so `COLOR=#fff` really does read as empty. Surprising,
 *    but it is what the loader does, and showing something else would be showing a lie.
 */
function envValue(raw) {
  const trimmed = raw.trim();
  const quote = trimmed.length > 1 && trimmed[0] === trimmed.at(-1) ? trimmed[0] : null;
  if (quote !== "'" && quote !== '"' && quote !== '`') return trimmed;
  const inner = trimmed.slice(1, -1);
  if (quote !== '"') return inner;
  return inner.replace(/\\([nrt"\\])/g, (_, char) => ESCAPES[char]);
}

/**
 * @returns {{variables: {key: string, value: string}[], skipped: string[], truncated: boolean}}
 *   `skipped` names the assignments that are not valid variable names, so the form can say so rather
 *   than appear to have read a shorter file than it did.
 */
function parseEnv(content) {
  // Last assignment wins, as it does in every dotenv loader — so a file that sets a key twice is
  // read here the way the application loading it will read it.
  const values = new Map();
  const skipped = new Set();
  for (const [, key, raw] of content.matchAll(ASSIGNMENT)) {
    if (ENV_KEY_PATTERN.test(key)) values.set(key, envValue(raw));
    else skipped.add(key);
  }
  const variables = [...values].map(([key, value]) => ({ key, value }));
  return {
    variables: variables.slice(0, MAX_ENV_VARIABLES),
    skipped: [...skipped],
    truncated: variables.length > MAX_ENV_VARIABLES,
  };
}

/**
 * A file that cannot be read reports why rather than vanishing from the list: a .env the form
 * silently skipped would be indistinguishable from a .env with nothing in it.
 */
async function readEnvFile(dir, name) {
  const file = path.join(dir, name);
  try {
    return { name, path: file, error: null, ...parseEnv(await readBounded(file, MAX_ENV_BYTES)) };
  } catch (err) {
    return { name, path: file, error: err.message, variables: [], skipped: [], truncated: false };
  }
}

/**
 * What the process form can fill in for itself once it knows the directory the command will run in:
 * the scripts that directory's package.json declares, and the variables its .env files already set.
 *
 * One listing drives all of it — the package.json, the lockfile that says which manager runs it, and
 * the set of .env files — because they are all the same question about the same directory.
 * @param {string} requested absolute path
 * @returns {Promise<{path: string, packageName: string|null, packageManager: string|null,
 *                    scripts: object[], envFiles: object[]}>}
 */
export async function inspect(requested) {
  const dir = resolveDirectory(requested);
  const names = await readdir(dir).catch(unreadable(dir));
  const pkg = names.includes('package.json') ? await readPackage(dir) : null;
  const manager = packageManagerOf(pkg, names);
  return {
    path: dir,
    packageName: pkg?.name ?? null,
    packageManager: manager,
    scripts: pkg ? scriptSuggestions(pkg.scripts, manager) : [],
    envFiles: await Promise.all(envFileNames(names).map((name) => readEnvFile(dir, name))),
  };
}
