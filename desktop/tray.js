/**
 * The tray — the menu bar on macOS. It is how the app is reached once its window is closed, and the
 * one place, with the Dock and Cmd-Q, that quits it. Quitting stops every service the app's server
 * supervises, so it is never a side effect of closing a window, and the menu says so where it matters.
 */
import path from 'node:path';
import { Menu, Tray, app } from 'electron';
import { ASSETS_DIR } from './assets-dir.js';

/** macOS draws a template image in the menu bar's own colours; elsewhere the icon is shown as is. */
const ICON = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';

/**
 * The menu's update line, for what the updater is doing. A checkout never updates, so it has none.
 * @param {import('./updates.js').UpdateState} update
 * @param {{onInstallUpdate: () => void, onCheckForUpdates: () => void, stopsServices: string}} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function updateItems(update, { onInstallUpdate, onCheckForUpdates, stopsServices }) {
  switch (update.status) {
    case 'unavailable':
      return [];
    case 'ready':
      return [{ label: `Install ${update.version} and Restart${stopsServices}`, click: onInstallUpdate }];
    case 'checking':
      return [{ label: 'Checking for Updates…', enabled: false }];
    case 'downloading':
      return [{ label: `Downloading ${update.version}… ${update.progress ?? 0}%`, enabled: false }];
    default:
      return [{ label: 'Check for Updates…', click: onCheckForUpdates }];
  }
}

/**
 * @param {{attachedPid: number|null, updateState: import('./updates.js').UpdateState,
 *          onOpen: () => void, onQuit: () => void, onCopyMcpUrl: () => void,
 *          onInstallUpdate: () => void, onCheckForUpdates: () => void}} options
 *   `attachedPid` is the Paddock the app is showing without having started it, which quitting and
 *   updating both leave running
 * @returns {{showUpdateState: (state: import('./updates.js').UpdateState) => void}} holding the Tray,
 *   which must stay referenced: a collected Tray disappears
 */
export function createTray({
  attachedPid,
  updateState,
  onOpen,
  onQuit,
  onCopyMcpUrl,
  onInstallUpdate,
  onCheckForUpdates,
}) {
  const tray = new Tray(path.join(ASSETS_DIR, ICON));
  const stopsServices = attachedPid ? '' : ' — stops running services';
  let update = updateState;

  const render = () => {
    tray.setToolTip(update.status === 'ready' ? `Paddock — ${update.version} is ready to install` : 'Paddock');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Paddock', click: onOpen },
        { label: 'Copy MCP URL', click: onCopyMcpUrl },
        { type: 'separator' },
        { label: `Paddock ${app.getVersion()}`, enabled: false },
        ...updateItems(update, { onInstallUpdate, onCheckForUpdates, stopsServices }),
        ...(attachedPid
          ? [{ label: `Showing the Paddock already running (pid ${attachedPid})`, enabled: false }]
          : []),
        { label: attachedPid ? 'Quit, leaving that Paddock running' : 'Quit Paddock', click: onQuit },
      ])
    );
  };

  render();
  // On Windows a click on a tray icon is expected to open the app; the menu is the right click.
  if (process.platform !== 'darwin') tray.on('click', onOpen);
  return {
    showUpdateState(state) {
      update = state;
      render();
    },
  };
}
