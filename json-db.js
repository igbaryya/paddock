/**
 * The whole persistence layer: one JSON document, read through an in-memory cache and written
 * atomically (temp sibling → fsync → rename). Writes are serialised through a promise-chain mutex
 * so two concurrent mutations cannot read-modify-write over each other — Node's single thread makes
 * that enough, there is no cross-process locking and none is needed for a single local manager.
 *
 * Recovery is deliberately narrow: only a parse failure quarantines the file. Anything else (EACCES,
 * EIO, a migration bug) propagates, because "rename the user's healthy file away and start empty" is
 * a data-loss event, not a recovery.
 */
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DB_FILE } from './config.js';

const CURRENT_VERSION = 1;

const MAX_QUARANTINE_SCAN = 1_000;

const noop = () => {};

const asArray = (value) => (Array.isArray(value) ? value : []);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultDocument = () => ({
  version: CURRENT_VERSION,
  applications: [],
  preferences: { mcp: { port: null, configured: false, enabled: false, lastStartedAt: null, lastStoppedAt: null, audit: [] } },
});

/** A document written by a newer build: refuse, never downgrade. Downgrading loses fields silently. */
export class UnsupportedVersionError extends Error {
  /** @param {number} version @param {string} file */
  constructor(version, file) {
    super(
      `${file} was written by a newer version of paddock (document version ${version}, this build ` +
        `understands ${CURRENT_VERSION}). Upgrade paddock, or move that file aside.`
    );
    this.name = 'UnsupportedVersionError';
    this.version = version;
  }
}

/** @type {object|null} */
let cached = null;

/** @type {Promise<unknown>} */
let tail = Promise.resolve();

/**
 * Run `job` after every job queued before it. `tail` is kept non-rejecting on purpose: without the
 * `noop, noop` the chain is poisoned by the first failure and every later caller fast-fails with a
 * stale error instead of running.
 * @param {() => Promise<any>} job
 */
function enqueue(job) {
  const run = tail.then(job);
  tail = run.then(noop, noop);
  return run;
}

/**
 * Forward migrations by `doc.version`. Version 1 is the only shape so far, so this only fills in
 * missing fields — but it stays, and it stays tolerant: the file is plain JSON in the user's data
 * directory and a hand-edited one must not throw its way into data loss. An application written
 * before PostgreSQL applications existed is a group of processes, which is what `kind` defaults to.
 * @param {object} doc
 */
function migrate(doc) {
  const applications = asArray(doc.applications)
    .filter(isObject)
    .map((app) => ({
      kind: 'processes',
      postgres: null,
      ...app,
      processes: asArray(app.processes).filter(isObject),
    }));
  const mcp = {
    port: null,
    configured: false,
    enabled: false,
    lastStartedAt: null,
    lastStoppedAt: null,
    audit: [],
    ...(isObject(doc.preferences?.mcp) ? doc.preferences.mcp : {}),
  };
  return {
    ...doc,
    version: CURRENT_VERSION,
    applications,
    preferences: { ...(isObject(doc.preferences) ? doc.preferences : {}), mcp },
  };
}

/**
 * First free `<file>.corrupt-<n>`, so a second corruption never overwrites the evidence of the
 * first. The scan is bounded: past that many kept copies the user has a different problem, and a
 * random suffix still cannot collide.
 */
async function quarantinePath() {
  for (let n = 1; n <= MAX_QUARANTINE_SCAN; n += 1) {
    const candidate = `${DB_FILE}.corrupt-${n}`;
    const taken = await fs.access(candidate).then(() => true, () => false);
    if (!taken) return candidate;
  }
  return `${DB_FILE}.corrupt-${randomBytes(6).toString('hex')}`;
}

/** @param {string} reason */
async function quarantine(reason) {
  const kept = await quarantinePath();
  await fs.rename(DB_FILE, kept);
  console.error(`[paddock] ${DB_FILE} ${reason} — kept as ${kept}, starting from an empty document`);
}

async function loadDocument() {
  let raw;
  try {
    raw = await fs.readFile(DB_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return defaultDocument();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    await quarantine('is not valid JSON');
    return defaultDocument();
  }

  if (!isObject(parsed)) {
    await quarantine('does not contain a JSON object');
    return defaultDocument();
  }
  if (Number.isInteger(parsed.version) && parsed.version > CURRENT_VERSION) {
    throw new UnsupportedVersionError(parsed.version, DB_FILE);
  }
  return migrate(parsed);
}

/**
 * Make the rename itself durable. `open(dir, 'w')` throws EISDIR, hence 'r'; the whole thing is
 * unsupported on Windows, so every failure here is ignored.
 * @param {string} dir
 */
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // best effort
  } finally {
    await handle?.close().catch(noop);
  }
}

/**
 * 'wx' so a name collision fails loudly instead of clobbering another writer; `sync()` is a real
 * F_FULLFSYNC on macOS, which is what makes the rename below safe to treat as committed.
 * @param {string} tmp @param {object} doc
 */
async function writeTemp(tmp, doc) {
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The temp file is a sibling of the target because `rename` is only atomic within one filesystem.
 * Any failure — a full disk mid-write as much as a failed rename — takes the temp file with it, so
 * a struggling disk cannot litter the user's data directory.
 * @param {object} doc
 */
async function writeDocument(doc) {
  const dir = path.dirname(DB_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(DB_FILE)}.${randomBytes(8).toString('hex')}.tmp`);

  try {
    await writeTemp(tmp, doc);
    await fs.rename(tmp, DB_FILE);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(noop);
    throw err;
  }
  await syncDirectory(dir);
}

/** @returns {Promise<object>} the document, migrated to the current version */
export async function read() {
  if (cached) return structuredClone(cached);
  return enqueue(async () => {
    // A caller queued ahead of us may have loaded it already; loading twice would quarantine twice.
    cached ??= await loadDocument();
    return structuredClone(cached);
  });
}

/**
 * Read-modify-write under the mutex. `mutate` gets a private copy, so abandoning a mutation
 * half-way (by throwing) cannot leave the cache holding a partially edited document. The result is
 * cloned *before* the write for the same reason in reverse: an unclonable document must fail here,
 * not after it has already landed on disk, and the cache must not be an object the caller still holds.
 * @param {(doc: object) => object|Promise<object>} mutate
 * @returns {Promise<object>} the new document
 */
export async function update(mutate) {
  return enqueue(async () => {
    cached ??= await loadDocument();
    const next = await mutate(structuredClone(cached));
    if (!isObject(next)) throw new TypeError('update(mutate) must return the new document object');
    const stored = structuredClone(next);
    await writeDocument(stored);
    cached = stored;
    return structuredClone(stored);
  });
}
