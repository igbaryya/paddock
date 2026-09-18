/**
 * Updates, from the GitHub releases the release workflow publishes. They are found and downloaded in
 * the background, and installed only when the user asks — installing quits the app, and quitting
 * stops every service its server supervises — or when the app is quit anyway.
 *
 * Only an installed app updates: a checkout has no feed to read. macOS will not install an update
 * into an unsigned app, so an unsigned build finds updates and fails to apply them; that failure is
 * logged rather than shown, because there is nothing the user can do about it from here.
 */
import { app } from 'electron';
import electronUpdater from 'electron-updater';

// electron-updater is CommonJS, so its named export is reached through the default one.
const { autoUpdater } = electronUpdater;

/** A check is a request to GitHub, and releases are rare; an app left running still sees one the same day. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

/** @param {(version: string) => void} onReady called once an update is downloaded and can be installed */
export function watchForUpdates(onReady) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', ({ version }) => onReady(version));
  autoUpdater.on('error', (err) => console.error(`[paddock] update: ${err.message}`));
  // A failed check rejects as well as emitting 'error', which has already reported it.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

/**
 * Hand over to the installer, which relaunches the app when it is done. The caller stops the server
 * first: the Windows installer gives the app about a second to exit before killing it, and kills only
 * the app's own processes — the dev servers would outlive it.
 */
export const installUpdate = () => autoUpdater.quitAndInstall(true, true);
