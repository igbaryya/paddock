/**
 * Updates, from the GitHub releases the release workflow publishes. They are found and downloaded in
 * the background, and installed only when the user asks — installing quits the app, and quitting
 * stops every service its server supervises — or when the app is quit anyway.
 *
 * What the updater is doing is kept as one state, which the tray and the dashboard both show.
 *
 * Only an installed app updates: a checkout, or a build packed locally without publishing, has no feed
 * to read, and its state stays 'unavailable'.
 * macOS will not install an update into an unsigned app, so an unsigned build finds updates and fails
 * to apply them; that failure is logged, and shows as an 'error' state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';

// electron-updater is CommonJS, so its named export is reached through the default one.
const { autoUpdater } = electronUpdater;

/** A check is a request to GitHub, and releases are rare; an app left running still sees one the same day. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

/** Long enough for any error's own sentence, short enough for a line in Settings. */
const ERROR_TEXT_MAX = 160;

/**
 * @typedef {object} UpdateState
 * @property {'unavailable'|'idle'|'checking'|'up-to-date'|'downloading'|'ready'|'error'} status
 * @property {string|null} version the update's version, once one has been found
 * @property {number|null} progress download percentage, 0–100, while one is under way
 * @property {string|null} error what went wrong, in the 'error' state
 * @property {string|null} checkedAt ISO time of the last check that finished, either way
 */

/** @type {UpdateState} */
let state = { status: 'unavailable', version: null, progress: null, error: null, checkedAt: null };

/** @type {Set<(state: UpdateState) => void>} */
const listeners = new Set();

/**
 * A downloaded update stays ready until it is installed: later checks run again and pass through the
 * other states, and an offline one would otherwise take away the offer to install what is on disk.
 * @param {Partial<UpdateState>} change
 */
function setState(change) {
  if (state.status === 'ready' && change.status !== 'ready') return;
  state = { ...state, ...change };
  for (const listener of listeners) listener(state);
}

/** @returns {UpdateState} */
export const getUpdateState = () => state;

/**
 * @param {(state: UpdateState) => void} listener called on every change
 * @returns {() => void} unsubscribes
 */
export function onUpdateState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Where a packaged app keeps its feed, written by electron-builder only for a build that publishes.
 * A local `--dir` build has none, and would otherwise fail every check.
 */
const hasFeed = () => fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));

/**
 * What the user sees of a failure: its first line, which is what it is about. electron-updater's
 * GitHub errors go on to carry the response, which belongs in the log.
 * @param {Error} err
 */
const shortError = (err) => {
  const line = err.message.split('\n', 1)[0];
  return line.length > ERROR_TEXT_MAX ? `${line.slice(0, ERROR_TEXT_MAX - 1)}…` : line;
};

export function watchForUpdates() {
  if (!app.isPackaged || !hasFeed()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  followUpdater();
  setState({ status: 'idle' });
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

function followUpdater() {
  const now = () => new Date().toISOString();
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => setState({ status: 'up-to-date', checkedAt: now() }));
  autoUpdater.on('update-available', ({ version }) =>
    setState({ status: 'downloading', version, progress: 0, checkedAt: now() })
  );
  autoUpdater.on('download-progress', ({ percent }) => setState({ progress: Math.round(percent) }));
  autoUpdater.on('update-downloaded', ({ version }) => setState({ status: 'ready', version, progress: 100 }));
  autoUpdater.on('error', (err) => {
    console.error(`[paddock] update: ${err.message}`);
    setState({ status: 'error', error: shortError(err), progress: null, checkedAt: now() });
  });
}

/** A failed check rejects as well as emitting 'error', which has already recorded it. */
const check = () => autoUpdater.checkForUpdates().catch(() => {});

/**
 * A check the user asked for. A found update downloads as a background one does.
 * @returns {Promise<UpdateState>} the state the check left, for an answer to show
 */
export async function checkForUpdatesNow() {
  if (state.status === 'unavailable' || state.status === 'ready') return state;
  await check();
  return state;
}

/**
 * Hand over to the installer, which relaunches the app when it is done. The caller stops the server
 * first: the Windows installer gives the app about a second to exit before killing it, and kills only
 * the app's own processes — the dev servers would outlive it.
 */
export const installUpdate = () => autoUpdater.quitAndInstall(true, true);
