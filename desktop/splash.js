/**
 * The splash screen, for the seconds the app's own server takes to come up. It closes once the
 * dashboard is on screen, or when the start fails and a dialog takes its place. A Paddock that is
 * already running needs none — its dashboard opens at once — and a login opens to the tray, so it
 * shows nothing at all.
 */
import path from 'node:path';
import { BrowserWindow, app } from 'electron';
import { APP_ICON, ASSETS_DIR } from './assets-dir.js';
import { pageBackground } from './window.js';

/**
 * The renderer reads this page itself, and its file:// cannot see into the app's archive: with the
 * grantFileProtocolExtraPrivileges fuse off it has Chromium's plain file loader, not Electron's asar
 * one. So a packaged app keeps the page and the icon it shows unpacked beside the archive.
 */
const PAGE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets') : ASSETS_DIR;

const PAGE = path.join(PAGE_DIR, 'splash.html');

/** @type {BrowserWindow|null} */
let splash = null;

export function showSplash() {
  splash = createSplash();
  splash.on('closed', () => {
    splash = null;
  });
}

/** Destroyed rather than closed, like the dashboard at quit: nothing on the page needs to finish. */
export function closeSplash() {
  splash?.destroy();
}

function createSplash() {
  const window = new BrowserWindow({
    width: 380,
    height: 320,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Paddock',
    icon: APP_ICON,
    backgroundColor: pageBackground(),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.once('ready-to-show', () => window.show());
  window.loadFile(PAGE, { query: { version: app.getVersion() } });
  return window;
}
