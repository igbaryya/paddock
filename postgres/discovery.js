/**
 * PostgreSQL clusters on this machine, for the new-application form to offer. Read-only: nothing
 * here starts, stops or writes anything, and what it finds is a suggestion the user picks from.
 *
 * Two sources. Running postmasters come from the process table, and a running one gives up nearly
 * everything — its data directory is its working directory, its binary is its executable, and its
 * log is whatever its stderr was redirected to. Stopped clusters come from the directories installers
 * put them in, plus the home directory's own subdirectories, where hand-made ones like ~/pg14_data
 * live. A stopped cluster anywhere else cannot be found without walking the disk, which this never
 * does.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processPaths, processSnapshot } from '../platform/index.js';
import { configuredPort, inspect, readVersion } from './data-directory.js';

/**
 * argv[0] of a postmaster, however it was launched. Its children retitle themselves
 * "postgres: checkpointer", which the colon keeps out.
 */
const POSTMASTER = /^(?:\S*[/\\])?postgres(?:\.exe)?(?:\s|$)/;

/**
 * Home subdirectories macOS guards behind a privacy prompt. Looking inside one from a Paddock started
 * at login would put a permission dialog on screen for a directory no cluster is kept in.
 */
const PROTECTED_HOME_DIRECTORIES = new Set([
  'Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public',
]);

/** Directories whose children installers name as data directories. */
const installerParents = (home) => [
  '/opt/homebrew/var', // Homebrew on Apple silicon: postgresql@16, postgres
  '/usr/local/var', // Homebrew on Intel
  path.join(home, 'Library', 'Application Support', 'Postgres'), // Postgres.app: var-16
];

/** Where each installer keeps one major version's binaries — stable paths that survive an upgrade. */
const binDirectoryCandidates = (major) => [
  `/opt/homebrew/opt/postgresql@${major}/bin`,
  `/usr/local/opt/postgresql@${major}/bin`,
  `/Applications/Postgres.app/Contents/Versions/${major}/bin`,
  `/usr/lib/postgresql/${major}/bin`,
];

const exists = (file) => fs.access(file).then(() => true, () => false);

const realpathOf = (file) => fs.realpath(file).catch(() => null);

/** @returns {Promise<string[]>} the subdirectories of `parent` that hold a cluster */
async function clustersIn(parent, skip = () => false) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip(entry.name))
    .map((entry) => path.join(parent, entry.name));
  const flagged = await Promise.all(directories.map((dir) => exists(path.join(dir, 'PG_VERSION'))));
  return directories.filter((_, index) => flagged[index]);
}

async function stoppedCandidates() {
  const home = os.homedir();
  const found = await Promise.all([
    ...installerParents(home).map((parent) => clustersIn(parent)),
    clustersIn(home, (name) => PROTECTED_HOME_DIRECTORIES.has(name)),
  ]);
  return found.flat().map((dataDirectory) => ({ dataDirectory, executablePath: null, logFile: null }));
}

/**
 * A postmaster changes into its data directory before it does anything else, so its working
 * directory is the data directory. One owned by another user reports no paths, and is skipped.
 */
async function runningCandidates() {
  const snapshot = await processSnapshot();
  const postmasters = [...snapshot.values()].filter((proc) => POSTMASTER.test(proc.commandLine ?? ''));
  const described = await Promise.all(postmasters.map(async (proc) => {
    const paths = await processPaths(proc.pid);
    return {
      dataDirectory: paths.workingDirectory,
      executablePath: paths.executablePath,
      logFile: paths.stderrPath,
    };
  }));
  return described.filter((candidate) => candidate.dataDirectory);
}

/**
 * The bin directory to suggest. A running server names the versioned directory it was launched
 * from (Homebrew's Cellar/postgresql@14/14.20/bin), which an upgrade deletes; the installer's stable
 * path is offered instead whenever it still points at that same binary.
 */
async function binDirectoryFor(major, executablePath) {
  const candidates = binDirectoryCandidates(major);
  const present = await Promise.all(candidates.map((dir) => exists(path.join(dir, 'pg_ctl'))));
  const stable = candidates.find((_, index) => present[index]) ?? null;
  if (!executablePath) return stable;
  const actual = path.dirname(executablePath);
  if (stable && (await realpathOf(stable)) === (await realpathOf(actual))) return stable;
  return actual;
}

/** initdb makes the OS account that ran it the superuser, and that account owns the directory. */
async function userFor(dataDirectory) {
  const stats = await fs.stat(dataDirectory).catch(() => null);
  return stats && stats.uid === process.getuid?.() ? os.userInfo().username : null;
}

async function describe(candidate) {
  const version = await readVersion(candidate.dataDirectory);
  if (!version) return null;
  const seen = await inspect(candidate.dataDirectory);
  return {
    dataDirectory: candidate.dataDirectory,
    version,
    running: seen.running,
    pid: seen.running ? seen.pid : null,
    port: seen.running && seen.port ? seen.port : await configuredPort(candidate.dataDirectory),
    binDirectory: await binDirectoryFor(version.split('.')[0], candidate.executablePath),
    user: await userFor(candidate.dataDirectory),
    logFile: candidate.logFile,
  };
}

/**
 * The same cluster can be both running and in an installer's directory, and reached through a
 * symlink; the running sighting carries more, so it is the one kept.
 */
async function distinct(candidates) {
  const byRealPath = new Map();
  for (const candidate of candidates) {
    const real = await realpathOf(candidate.dataDirectory);
    if (real && !byRealPath.has(real)) byRealPath.set(real, { ...candidate, dataDirectory: real });
  }
  return [...byRealPath.values()];
}

/**
 * @returns {Promise<{dataDirectory: string, version: string, running: boolean, pid: number|null,
 *                    port: number, binDirectory: string|null, user: string|null,
 *                    logFile: string|null}[]>} running clusters first, then by path
 */
export async function discover() {
  const [running, stopped] = await Promise.all([runningCandidates(), stoppedCandidates()]);
  const described = await Promise.all((await distinct([...running, ...stopped])).map(describe));
  return described
    .filter(Boolean)
    .sort((a, b) => Number(b.running) - Number(a.running) || a.dataDirectory.localeCompare(b.dataDirectory));
}
