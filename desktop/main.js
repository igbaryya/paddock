/**
 * The desktop app: the Paddock server in a utility process, its dashboard in a window, and a tray
 * that outlives the window. Everything Paddock does stays in the server. This file decides which
 * server the window shows, and makes quitting the app a graceful stop of the server it started.
 *
 * Closing the window stops nothing. Agents reach /mcp and dev servers keep running whether or not a
 * window is open, so the app lives on in the tray until it is quit — and a quit waits for the server
 * to stop its process groups before the app exits.
 */
import path from 'node:path';
import { app, dialog } from 'electron';
import { handleServerRequest, openedAtLogin } from './login-item.js';
import { SERVER_DIR, importServerModule } from './server-dir.js';
import { probe, startServer } from './server-process.js';
import { closeSplash, showSplash } from './splash.js';
import { createTray } from './tray.js';
import { installUpdate, watchForUpdates } from './updates.js';
import { closeDashboard, showDashboard } from './window.js';

/**
 * The macOS render, margin and shadow included. Only a checkout needs it at runtime: it runs inside
 * Electron's own bundle, whose icon the Dock would show. An installed app carries it as its .icns.
 */
const CHECKOUT_DOCK_ICON = path.join(app.getAppPath(), 'build', 'icon.png');

/** Held for the life of the app: a collected Tray disappears from the menu bar. */
let tray = null;

/** Set once a quit or an update has begun, after which a server exit is expected, not a failure. */
let quitting = false;

/**
 * A failure the user has to act on. The app cannot do its job without its server, so it quits.
 * @param {string} message
 * @param {string} detail
 */
function fail(message, detail) {
  closeSplash();
  dialog.showMessageBoxSync({ type: 'error', title: 'Paddock', message, detail });
  app.quit();
}

/**
 * The server's environment: the app's own, plus what login-item.js on the server side reads — the
 * program a login should open, and whether a login opened this one.
 */
const serverEnv = () => ({
  ...process.env,
  PADDOCK_DESKTOP_APP: app.getPath('exe'),
  ...(openedAtLogin() && { PADDOCK_LOGIN_ITEM: '1' }),
});

/**
 * Quitting waits for the server to stop what it supervises. The first `before-quit` is held while it
 * does; the quit it then asks for again finds the server gone and goes through.
 * @param {{stop: () => Promise<void>}} server
 */
function stopServerBeforeQuit(server) {
  let stopped = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    closeSplash();
    closeDashboard();
    server.stop().then(() => {
      stopped = true;
      app.quit();
    });
  });
}

/**
 * @param {Awaited<ReturnType<typeof importServerModule>>} config the server's config.js
 * @returns {Promise<{url: string, stop: () => Promise<void>}|null>} null when the server did not come up
 */
async function runOwnServer(config) {
  if (!openedAtLogin()) showSplash();
  const server = startServer({
    serverDir: SERVER_DIR,
    env: serverEnv(),
    logFile: path.join(config.LOG_DIR, 'paddock.log'),
    stopGraceMs: config.SHUTDOWN_GRACE_MS,
    onRequest: handleServerRequest,
  });
  stopServerBeforeQuit(server);
  const url = await server.ready.catch((err) => {
    fail('Paddock could not start.', err.message);
    return null;
  });
  // Only once it is up: an exit before then is the failed start just reported.
  server.exited.then(({ code, output }) => {
    if (url && !quitting) fail(`Paddock's server stopped unexpectedly (exit code ${code}).`, output);
  });
  return url && { url, stop: server.stop };
}

/**
 * The server this app shows: one already on the port if it is a Paddock, otherwise one of its own.
 * Only its own is ever stopped.
 * @returns {Promise<{url: string, attachedPid: number|null, stop: () => Promise<void>}|null>} null when
 *   there is nothing to show
 */
async function resolveServer(config) {
  const origin = `http://${config.DISPLAY_HOST}:${config.PORT}`;
  const existing = await probe(origin);
  if (existing.state === 'paddock') {
    return { url: origin, attachedPid: existing.pid, stop: () => Promise.resolve() };
  }
  if (existing.state === 'taken') {
    fail(
      `Something other than Paddock is using port ${config.PORT}.`,
      `Stop it, or give Paddock another port with PADDOCK_PORT=<port> in ${config.ENV_FILE}. ` +
        'Agents configured with the old MCP URL will need the new one.'
    );
    return null;
  }
  const own = await runOwnServer(config);
  return own && { ...own, attachedPid: null };
}

/**
 * Installing an update restarts the app, so it is a quit: the server stops what it supervises before
 * the installer takes over, rather than being killed by it.
 * @param {{stop: () => Promise<void>}} server
 */
async function installUpdateAfterStopping(server) {
  quitting = true;
  closeDashboard();
  await server.stop();
  installUpdate();
}

async function main() {
  // Chromium's profile would otherwise land in "Paddock", which on the case-insensitive file systems
  // of macOS and Windows is the server's own data directory. First, because the lock below lives there.
  app.setPath('userData', path.join(app.getPath('appData'), 'Paddock Desktop'));
  // A second launch focuses the first, through 'second-instance' below.
  if (!app.requestSingleInstanceLock()) return app.quit();
  // An installed app has no checkout to keep a .env in; set before the server's config is read.
  if (app.isPackaged) process.env.PADDOCK_ENV_FILE ??= path.join(app.getPath('userData'), 'paddock.env');
  const config = await importServerModule('config.js');
  await app.whenReady();
  if (!app.isPackaged) app.dock?.setIcon(CHECKOUT_DOCK_ICON);
  // Without a listener Electron quits when the last window closes; the tray is what keeps it here.
  // Registered before the splash can open: closing it must never be what quits the app, least of
  // all under the dialog of a start that failed.
  app.on('window-all-closed', () => {});

  const server = await resolveServer(config);
  if (!server) return;
  const open = () => showDashboard(server.url);
  app.on('second-instance', open);
  app.on('activate', open);
  tray = createTray({
    mcpUrl: new URL('/mcp', server.url).href,
    attachedPid: server.attachedPid,
    onOpen: open,
    onQuit: () => app.quit(),
    onInstallUpdate: () => installUpdateAfterStopping(server),
  });
  watchForUpdates((version) => tray.offerUpdate(version));
  // A splash, if the server start put one up, stays until the dashboard has painted in its place.
  if (!openedAtLogin()) open().then(closeSplash);
}

// A terminal running the app, or logout, asks the same graceful quit as the tray does.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());

main().catch((err) => {
  dialog.showErrorBox('Paddock', err.stack ?? String(err));
  app.exit(1);
});
