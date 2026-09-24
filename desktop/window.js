/**
 * The dashboard window: the server's own UI, loaded from the server's own origin — which is exactly
 * what the local-origin guard admits, so the app needs no exception from it. Closing the window only
 * closes it. The server keeps supervising and the app stays in the tray; reopening loads the page
 * afresh rather than keeping a hidden renderer alive for hours.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import { APP_ICON } from './assets-dir.js';

/** Gives the dashboard `window.paddockDesktop`; what it can ask is answered in bridge.js. */
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

/** The dashboard's own page colours (--bg in ui/src/styles.css), so a new window does not flash. */
const BACKGROUND = { dark: '#0a0d13', light: '#f4f6f8' };

/** The splash page is drawn on the same ground, so both windows open without a flash. */
export const pageBackground = () => (nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light);

/** @type {BrowserWindow|null} */
let dashboard = null;

/**
 * @param {string} url
 * @returns {Promise<void>} settles once the window is on screen, which for a new one is after its
 *   first paint
 */
export function showDashboard(url) {
  if (!dashboard) {
    dashboard = createDashboard(url);
    dashboard.on('closed', () => {
      dashboard = null;
    });
    return new Promise((resolve) => dashboard.once('show', resolve));
  }
  if (dashboard.isMinimized()) dashboard.restore();
  dashboard.show();
  dashboard.focus();
  return Promise.resolve();
}

/** For quitting: the window goes at once, while the server may take seconds to stop. */
export function closeDashboard() {
  dashboard?.destroy();
}

/** @param {string} url */
function createDashboard(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Paddock',
    // The title bar and taskbar icon on Windows and Linux; macOS takes the app's own and ignores this.
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: pageBackground(),
    webPreferences: { sandbox: true, contextIsolation: true, preload: PRELOAD },
  });
  keepOtherPagesOut(window, new URL(url).origin);
  window.once('ready-to-show', () => window.show());
  window.loadURL(url);
  return window;
}

/**
 * The window only ever shows the dashboard. Anything else it is asked to open goes to the user's
 * browser, and only when it is a web address — never a file, never a custom scheme.
 * @param {BrowserWindow} window
 * @param {string} origin
 */
function keepOtherPagesOut(window, origin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (URL.parse(event.url)?.origin === origin) return;
    event.preventDefault();
    openInBrowser(event.url);
  });
}

/** @param {string} target */
function openInBrowser(target) {
  const protocol = URL.parse(target)?.protocol;
  if (protocol === 'http:' || protocol === 'https:') shell.openExternal(target);
}
