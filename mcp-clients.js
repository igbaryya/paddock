/**
 * Paddock's entry in the MCP settings of the agents a developer is likely to run — so connecting one
 * is a click on the MCP settings tab rather than a URL pasted into a JSON file by hand.
 *
 * Each client is one fixed file under the home directory and one fixed entry shape. A request names a
 * client id from the list below, never a path, and the URL written is this server's own: the route
 * can write exactly these files, and only the `paddock` key inside their `mcpServers`. Everything
 * else in the file is carried over as it was read. Dashboard-only, like Start at login — which
 * programs an agent can reach is the user's decision, not an agent's.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, ValidationError } from './applications.js';

export const ENTRY_NAME = 'paddock';

/** Hostnames that all reach this machine's loopback, so an entry naming either is not stale. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Mode for a file this module creates: a client's MCP file can hold other servers' tokens. */
const NEW_FILE_MODE = 0o600;

/**
 * `markers` say the client is installed, and their modification times say how recently it ran —
 * which is what picks the suggestion when both are installed.
 */
const CLIENTS = [
  {
    id: 'cursor',
    name: 'Cursor',
    // User-wide, so every folder opened in Cursor reaches Paddock; a project's own .cursor/mcp.json
    // would cover that one folder.
    file: (home) => path.join(home, '.cursor', 'mcp.json'),
    markers: (home) => [path.join(home, '.cursor', 'projects'), path.join(home, '.cursor')],
    entry: (url) => ({ url }),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    // The top-level mcpServers of ~/.claude.json is Claude Code's user scope — where
    // `claude mcp add --scope user` writes. Claude Code rewrites this file on every run.
    file: (home) => path.join(home, '.claude.json'),
    markers: (home) => [path.join(home, '.claude.json'), path.join(home, '.claude')],
    entry: (url) => ({ type: 'http', url }),
  },
];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `~/…` for display: the full home path tells the user nothing and takes half the row. */
const displayPath = (file, home) =>
  file.startsWith(home + path.sep) ? `~${path.sep}${path.relative(home, file)}` : file;

/** Same host (any loopback spelling), port and path: an entry that would reach this server. */
function sameEndpoint(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const host = (url) => (LOOPBACK_HOSTS.has(url.hostname) ? 'loopback' : url.hostname);
    return host(left) === host(right) && left.port === right.port && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

/** @returns {Promise<number|null>} the newest modification time among the markers that exist */
async function lastUsed(markers) {
  const times = await Promise.all(
    markers.map((marker) => fs.stat(marker).then((stat) => stat.mtimeMs, () => null))
  );
  const found = times.filter((time) => time !== null);
  return found.length ? Math.max(...found) : null;
}

/**
 * A file that will not parse is reported, never replaced: rewriting it from nothing would drop every
 * other server the user configured there.
 * @returns {Promise<{doc: object, mode: number|null} | {error: string}>}
 */
async function readConfig(file) {
  let raw;
  let mode;
  try {
    raw = await fs.readFile(file, 'utf8');
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (err) {
    if (err.code === 'ENOENT') return { doc: {}, mode: null };
    return { error: `cannot be read (${err.code ?? err.message})` };
  }
  if (raw.trim() === '') return { doc: {}, mode };
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: 'is not valid JSON' };
  }
  if (!isObject(doc)) return { error: 'does not hold a JSON object' };
  if (doc.mcpServers !== undefined && !isObject(doc.mcpServers)) {
    return { error: 'has an mcpServers that is not an object' };
  }
  return { doc, mode };
}

/**
 * `configured` reaches this server; `stale` is a Paddock entry pointing somewhere else — usually the
 * port before it was changed. With no URL to compare against, an existing entry counts as configured.
 */
function entryState(config, url) {
  if ('error' in config) return { state: 'unreadable', configuredUrl: null };
  const current = config.doc.mcpServers?.[ENTRY_NAME];
  if (!isObject(current)) return { state: 'missing', configuredUrl: null };
  const configuredUrl = typeof current.url === 'string' ? current.url : null;
  const reaches = !url || (configuredUrl !== null && sameEndpoint(configuredUrl, url));
  return { state: reaches ? 'configured' : 'stale', configuredUrl };
}

async function describeClient(client, home, url) {
  const file = client.file(home);
  const [config, usedAt] = await Promise.all([readConfig(file), lastUsed(client.markers(home))]);
  return {
    id: client.id,
    name: client.name,
    detected: usedAt !== null,
    lastUsedAt: usedAt === null ? null : new Date(usedAt).toISOString(),
    configPath: file,
    displayPath: displayPath(file, home),
    ...entryState(config, url),
    error: config.error ?? null,
  };
}

/**
 * An installed client that does not reach Paddock yet; of two, the one that ran most recently.
 * Null once every installed client is connected — there is nothing left to suggest.
 */
function suggestion(clients) {
  const candidates = clients
    .filter((client) => client.detected && (client.state === 'missing' || client.state === 'stale'))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return candidates[0]?.id ?? null;
}

/**
 * @param {{home: string, url: string|null}} context
 * @returns {Promise<object[]>} every known client, with where Paddock stands in its settings
 */
export async function list({ home, url }) {
  const clients = await Promise.all(CLIENTS.map((client) => describeClient(client, home, url)));
  const suggested = suggestion(clients);
  return clients.map((client) => ({ ...client, suggested: client.id === suggested }));
}

/**
 * Temp sibling, then rename — a client reading the file mid-write sees the old one or the new one,
 * never half of either. A symlinked file (dotfiles kept in a repository) is written through, so the
 * link survives.
 */
async function writeAtomically(file, text, mode) {
  const target = await fs.realpath(file).catch(() => file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    const handle = await fs.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Add Paddock to one client's MCP settings, or point an existing entry at the current URL.
 * @param {string} clientId
 * @param {{home: string, url: string|null}} context
 */
export async function install(clientId, { home, url }) {
  const client = CLIENTS.find((candidate) => candidate.id === clientId);
  if (!client) {
    const known = CLIENTS.map((candidate) => candidate.id).join(', ');
    throw new NotFoundError(`unknown MCP client '${clientId}' — expected one of ${known}`);
  }
  if (!url) throw new ValidationError('MCP is not installed — choose a port first');

  const file = client.file(home);
  const config = await readConfig(file);
  if ('error' in config) {
    throw new ValidationError(`${displayPath(file, home)} ${config.error} — fix it by hand, then add Paddock again`);
  }
  // Spread rather than assigned: an mcpServers already in the file keeps its place among the keys.
  const doc = {
    ...config.doc,
    mcpServers: { ...(config.doc.mcpServers ?? {}), [ENTRY_NAME]: client.entry(url) },
  };
  await writeAtomically(file, `${JSON.stringify(doc, null, 2)}\n`, config.mode ?? NEW_FILE_MODE);
}
