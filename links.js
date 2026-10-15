/**
 * Which managed process has been seen connecting to which local port — the arrows on an
 * application's canvas.
 *
 * A port scan only ever sees the connections open at that instant, so one scan is a sample, not the
 * picture: a service that calls another without keep-alive is connected for milliseconds at a time.
 * Links therefore accumulate across scans and are kept on disk, so the graph is still drawn after
 * everything in it has stopped, and after Paddock restarts. A link not seen for LINK_RETENTION_MS is
 * dropped, which is how one a code change ended stops being drawn.
 *
 * A link is keyed by caller and port, never by the pid behind the port: pids change on every restart
 * and the port is what the caller is actually configured to reach. The target's description is
 * refreshed on each sighting.
 *
 * The file is a cache — missing, torn or hand-edited just means links are learned again — so it is
 * written plainly and read tolerantly, as favicons are.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LINKS_FILE } from './config.js';

const LINK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** `lastSeenAt` moves on every scan; it is written through at most this often, not every 5 s. */
const SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @type {Map<string, {applicationId: string, processId: string, port: number, target: object,
 *                     firstSeenAt: string, lastSeenAt: string}>}
 */
const links = new Map();

/** When each link's `lastSeenAt` last reached the disk. */
const writtenSeenAt = new Map();

const keyOf = (applicationId, processId, port) => `${applicationId}:${processId}->${port}`;

const sameTarget = (a, b) =>
  a.kind === b.kind &&
  a.applicationId === b.applicationId &&
  a.processId === b.processId &&
  a.name === b.name &&
  a.applicationName === b.applicationName &&
  a.processName === b.processName;

const isEntry = (value) =>
  typeof value?.applicationId === 'string' &&
  typeof value.processId === 'string' &&
  Number.isInteger(value.port) &&
  typeof value.target?.kind === 'string' &&
  !Number.isNaN(Date.parse(value.lastSeenAt));

/** Writes are chained so two scans landing together never interleave in the file. */
let writing = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify({ links: [...links.values()] }, null, 2);
  writing = writing
    .then(async () => {
      await fs.mkdir(path.dirname(LINKS_FILE), { recursive: true });
      await fs.writeFile(LINKS_FILE, snapshot);
    })
    .catch((err) => console.error(`[paddock] links not saved: ${err.message}`));
}

/** Settles once every write queued so far has reached the disk, or failed trying. */
export const flush = () => writing;

/** Load what earlier runs saw. A missing or unreadable file is an empty cache. */
export async function load() {
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(LINKS_FILE, 'utf8'));
  } catch {
    return;
  }
  const cutoff = Date.now() - LINK_RETENTION_MS;
  for (const entry of Array.isArray(stored?.links) ? stored.links : []) {
    if (!isEntry(entry) || Date.parse(entry.lastSeenAt) < cutoff) continue;
    const key = keyOf(entry.applicationId, entry.processId, entry.port);
    links.set(key, entry);
    writtenSeenAt.set(key, Date.parse(entry.lastSeenAt));
  }
}

/**
 * Fold one scan's links in.
 * @param {{applicationId: string, processId: string, port: number, target: object}[]} observed
 * @param {number} [now]
 * @returns {boolean} whether the set of links, or what one of them points at, changed — the only
 *   changes a canvas would draw differently
 */
export function record(observed, now = Date.now()) {
  const at = new Date(now).toISOString();
  let changed = false;
  let dirty = false;
  for (const { applicationId, processId, port, target } of observed) {
    const key = keyOf(applicationId, processId, port);
    const existing = links.get(key);
    if (!existing || !sameTarget(existing.target, target)) changed = true;
    links.set(key, {
      applicationId,
      processId,
      port,
      target,
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
    });
    if (now - (writtenSeenAt.get(key) ?? 0) >= SEEN_WRITE_INTERVAL_MS) {
      writtenSeenAt.set(key, now);
      dirty = true;
    }
  }
  if (changed || dirty) persist();
  return changed;
}

/**
 * @param {string} applicationId
 * @returns {object[]} the links whose caller is in this application, by caller then port
 */
export function of(applicationId) {
  return [...links.values()]
    .filter((link) => link.applicationId === applicationId)
    .sort((a, b) => a.processId.localeCompare(b.processId) || a.port - b.port);
}

/**
 * A removed process takes its links with it — both the ones it made and the ones made to it, which
 * would otherwise name a process that no longer exists until the port is seen again.
 * @param {string} applicationId
 * @param {string} [processId] every process of the application when omitted
 */
export function forget(applicationId, processId) {
  const matches = (id, proc) => id === applicationId && (processId === undefined || proc === processId);
  let removed = false;
  for (const [key, link] of links) {
    if (matches(link.applicationId, link.processId) || matches(link.target.applicationId, link.target.processId)) {
      links.delete(key);
      writtenSeenAt.delete(key);
      removed = true;
    }
  }
  if (removed) persist();
}
