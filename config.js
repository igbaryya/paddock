/**
 * Configuration and resolved paths. Nothing here is tied to one machine: the data directory follows
 * the OS convention and every value can be overridden with a PADDOCK_* variable. A .env next to
 * this file is loaded when present; variables already in the environment (the shell, a launcher, an
 * MCP client's `env` block) win over it. A bad value is a warning and a fallback, never a crash —
 * this process supervises the user's dev servers and must come up.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.PADDOCK_ENV_FILE || path.join(ROOT_DIR, '.env');

const warn = (message) => console.error(`[paddock] ${message}`);

/**
 * A .env that exists but cannot be read reports as a bare ENOENT from `loadEnvFile`, which would
 * stop the manager with a message naming a file that is plainly there. Warn and carry on instead —
 * the real environment may already hold everything we need.
 * @param {string} file
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    warn(`${file} could not be read — continuing without it (${err.message})`);
  }
}

loadEnvFile(ENV_FILE);

const trimmedEnv = (name) => process.env[name]?.trim() || undefined;

/**
 * @param {string} name
 * @param {number} fallback
 * @param {{min?: number, max?: number}} [range] ports may be 0 (ephemeral) and have a ceiling;
 *   buffer sizes and durations are only bounded below
 */
function intFromEnv(name, fallback, { min = 1, max = Infinity } = {}) {
  const raw = trimmedEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    const bounds = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    warn(`${name}="${raw}" is not an integer ${bounds} — using ${fallback}`);
    return fallback;
  }
  return value;
}

/** @param {string} name @param {boolean} fallback */
function boolFromEnv(name, fallback) {
  const raw = trimmedEnv(name)?.toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  warn(`${name}="${raw}" is not true/false — using ${fallback}`);
  return fallback;
}

/**
 * Per-OS application data directory. Takes its inputs as arguments so every branch is reachable
 * from a test on any host.
 * @param {{env: Record<string, string|undefined>, platform: string, home?: string}} ctx
 * @returns {string}
 */
export function resolveDataDir({ env, platform, home = os.homedir() }) {
  // A relative override resolves against the launch directory, which is why .env.example asks for
  // an absolute one — unlike XDG_DATA_HOME below, an explicit override is honoured either way.
  const override = env.PADDOCK_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    return path.join(env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming'), 'paddock');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'paddock');
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored, not resolved against cwd.
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'paddock');
  return path.join(home, '.local', 'share', 'paddock');
}

export const HOST = trimmedEnv('PADDOCK_HOST') || '127.0.0.1';

/** 0 is legal and means "an ephemeral port"; out of range would throw ERR_SOCKET_BAD_PORT at listen. */
export const PORT = intFromEnv('PADDOCK_PORT', 4599, { min: 0, max: 65_535 });

export const DATA_DIR = resolveDataDir({ env: process.env, platform: process.platform });

/** The configuration document: applications and their processes. */
export const DB_FILE = path.join(DATA_DIR, 'applications.json');

/** Spawn records for the orphan reaper only — never configuration, and safe to delete by hand. */
export const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');

export const LOG_DIR = path.join(DATA_DIR, 'logs');

/** Favicons found on running services — a cache, rebuilt by the next start, and safe to delete by hand. */
export const FAVICON_DIR = path.join(DATA_DIR, 'favicons');

export const LOG_BUFFER_LINES = intFromEnv('PADDOCK_LOG_BUFFER_LINES', 2_000);

export const LOG_FILE_MAX_BYTES = intFromEnv('PADDOCK_LOG_FILE_MAX_BYTES', 5_242_880);

export const LOG_PERSIST = boolFromEnv('PADDOCK_LOG_PERSIST', true);

/** How long a process group gets after SIGTERM before it is force-killed. */
export const STOP_GRACE_MS = intFromEnv('PADDOCK_STOP_GRACE_MS', 5_000);

/** How long a freshly spawned process must survive before it counts as running rather than starting. */
export const START_SETTLE_MS = intFromEnv('PADDOCK_START_SETTLE_MS', 1_500);

export const REAP_ORPHANS = boolFromEnv('PADDOCK_REAP_ORPHANS', true);

/** How long a port scan is reused. A scan costs tens of milliseconds of OS work, so it is shared. */
export const PORT_SCAN_TTL_MS = intFromEnv('PADDOCK_PORT_SCAN_TTL_MS', 3_000, { min: 250 });

/** How often connected dashboards are pushed a fresh port list; 0 disables background scanning. */
export const PORT_SCAN_INTERVAL_MS = intFromEnv('PADDOCK_PORT_SCAN_INTERVAL_MS', 5_000, { min: 0 });

/** Grace an unmanaged process gets between the polite signal and the forced one. */
export const PORT_STOP_GRACE_MS = intFromEnv('PADDOCK_PORT_STOP_GRACE_MS', 5_000);

/** Built UI. Absent until `npm run build` in ui/ — http/static.js says so rather than failing. */
export const UI_DIR = path.join(ROOT_DIR, 'ui', 'dist');
