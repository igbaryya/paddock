/**
 * Which managed processes serve a website, and where to open it. A process is a website when one of
 * its ports answers `GET /` with a successful HTML page — what a browser pointed at it would show.
 * An API answering JSON, a framework's HTML "Cannot GET /" 404, a database, or a port that is not
 * HTTP at all are not, so the dashboard only offers "Open in browser" where there is a page to see.
 *
 * Probes go only to ports a scan has tied to the process, and only on loopback. Each run of a process
 * gets a few attempts, spaced out — a dev server holds its port before it will answer, and the first
 * request to some compiles the page — and a new set of ports starts the count again. Nothing is
 * written to disk: a page is a fact about a run, and a restarted manager has no runs to remember.
 */
import { fetchLocal, originOf } from './loopback.js';

/** Enough of a page to find its `<title>`; the rest is never downloaded. */
const MAX_HEAD_BYTES = 65_536;
const MAX_PORTS_PROBED = 3;
const MAX_ATTEMPTS = 4;
const RETRY_AFTER_MS = 15_000;
const MAX_TITLE_LENGTH = 120;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HTML_START = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype html|html)[\s>]/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/**
 * Detection per process, for its current run and set of ports.
 * @type {Map<string, {startedAt: string, portsKey: string, attempts: number, lastAttemptAt: number,
 *                     inFlight: boolean, page: {port: number, url: string, title: string|null}|null}>}
 */
const runs = new Map();

const portsKeyOf = (listeners) =>
  listeners
    .map((listener) => listener.port)
    .sort((a, b) => a - b)
    .join(',');

/** A header can be missing or wrong on a dev server, so a page that starts like HTML counts too. */
const isHtml = ({ contentType, bytes }) =>
  /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType) ||
  (!contentType && HTML_START.test(bytes.subarray(0, 1_024).toString('utf8')));

function titleOf(html) {
  const raw = TITLE.exec(html)?.[1];
  if (!raw) return null;
  const text = raw
    .replace(/&(#39|[a-z]+);/gi, (entity, name) => ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, MAX_TITLE_LENGTH) : null;
}

/**
 * The address handed to the user's browser is `localhost`, whichever loopback address the probe
 * reached: it is what dev servers print, what their cookies and CORS settings are written for, and a
 * browser tries both address families for it.
 */
async function pageAt(listener) {
  const origin = originOf(listener);
  if (!origin) return null;
  const res = await fetchLocal(`${origin}/`, MAX_HEAD_BYTES, {
    truncate: true,
    headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
  });
  if (!res || !isHtml(res)) return null;
  return {
    port: listener.port,
    url: `http://localhost:${listener.port}/`,
    title: titleOf(res.bytes.toString('utf8')),
  };
}

async function findPage(listeners) {
  const ordered = [...listeners].sort((a, b) => a.port - b.port).slice(0, MAX_PORTS_PROBED);
  for (const listener of ordered) {
    const page = await pageAt(listener);
    if (page) return page;
  }
  return null;
}

function isDue({ processId, startedAt, listeners }) {
  const run = runs.get(processId);
  if (!run || run.startedAt !== startedAt || run.portsKey !== portsKeyOf(listeners)) return true;
  if (run.inFlight || run.page || run.attempts >= MAX_ATTEMPTS) return false;
  return Date.now() - run.lastAttemptAt >= RETRY_AFTER_MS;
}

/** @returns {Promise<boolean>} whether what `describe` answers for this process may have changed */
async function detectOne(target) {
  const { processId, startedAt, listeners } = target;
  const portsKey = portsKeyOf(listeners);
  const previous = runs.get(processId);
  const sameRun = previous?.startedAt === startedAt && previous.portsKey === portsKey;
  const hadPage = Boolean(previous?.page);
  runs.set(processId, {
    startedAt,
    portsKey,
    attempts: sameRun ? previous.attempts + 1 : 1,
    lastAttemptAt: Date.now(),
    inFlight: true,
    page: null,
  });

  const page = await findPage(listeners).catch(() => null);
  const run = runs.get(processId);
  // Forgotten, restarted or re-scanned while the probe was out: the entry belongs to someone else now.
  if (run?.startedAt !== startedAt || run.portsKey !== portsKey) return false;
  runs.set(processId, { ...run, inFlight: false, page });
  // The old page stopped being described the moment this attempt began, so a page found now is news
  // even when it is the same one.
  return Boolean(page) || hadPage;
}

/**
 * Probe every target that is due, concurrently across processes and one port at a time within one.
 * @param {{processId: string, startedAt: string|null,
 *          listeners: {port: number, addresses: string[]}[]}[]} targets running managed processes and
 *   the listeners a scan tied to them
 * @returns {Promise<boolean>} whether any process's page appeared, moved or went
 */
export async function detect(targets) {
  const due = targets.filter(
    (target) => SAFE_ID.test(target.processId) && target.startedAt && target.listeners.length && isDue(target)
  );
  const changed = await Promise.all(due.map(detectOne));
  return changed.some(Boolean);
}

/**
 * The page a process serves in its current run, while it still holds the port it was found on.
 * @param {string} processId
 * @param {string|null} startedAt the process's current run
 * @param {number[]|null} ports what the last scan says it holds
 * @returns {{port: number, url: string, title: string|null}|null}
 */
export function describe(processId, startedAt, ports) {
  const run = runs.get(processId);
  if (!run?.page || !startedAt || run.startedAt !== startedAt) return null;
  return ports?.includes(run.page.port) ? run.page : null;
}

/** @param {string} processId */
export function forget(processId) {
  runs.delete(processId);
}
