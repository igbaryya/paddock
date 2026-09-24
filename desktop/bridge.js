/**
 * What the dashboard can ask of the app it runs in: its version, and its updates. preload.cjs puts
 * these on `window.paddockDesktop`; a dashboard in a browser has no such object, and shows neither.
 *
 * Only the dashboard's own origin is answered. The window never navigates anywhere else, and this
 * holds even if it one day did.
 */
import { app, ipcMain, webContents } from 'electron';
import { checkForUpdatesNow, getUpdateState, onUpdateState } from './updates.js';

/** The same names are spelled out in preload.cjs, which cannot import this module. */
const CHANNEL = {
  version: 'paddock:version',
  updateState: 'paddock:update-state',
  checkForUpdates: 'paddock:check-for-updates',
  installUpdate: 'paddock:install-update',
  updateStateChanged: 'paddock:update-state-changed',
};

/**
 * @param {{origin: string, installUpdate: () => void}} options
 *   `origin` is the dashboard's; `installUpdate` stops the server before handing over to the installer
 */
export function exposeToDashboard({ origin, installUpdate }) {
  /** @param {(event: Electron.IpcMainInvokeEvent) => unknown} handler */
  const answer = (handler) => (event) => {
    if (URL.parse(event.senderFrame?.url ?? '')?.origin !== origin) throw new Error('Not the dashboard');
    return handler(event);
  };
  ipcMain.handle(CHANNEL.version, answer(() => app.getVersion()));
  ipcMain.handle(CHANNEL.updateState, answer(getUpdateState));
  ipcMain.handle(CHANNEL.checkForUpdates, answer(checkForUpdatesNow));
  ipcMain.handle(CHANNEL.installUpdate, answer(installUpdate));
  onUpdateState((state) => broadcast(origin, state));
}

/**
 * @param {string} origin
 * @param {import('./updates.js').UpdateState} state
 */
function broadcast(origin, state) {
  for (const contents of webContents.getAllWebContents()) {
    if (URL.parse(contents.getURL())?.origin === origin) contents.send(CHANNEL.updateStateChanged, state);
  }
}
