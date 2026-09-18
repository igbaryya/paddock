/**
 * The tray — the menu bar on macOS. It is how the app is reached once its window is closed, and the
 * one place, with the Dock and Cmd-Q, that quits it. Quitting stops every service the app's server
 * supervises, so it is never a side effect of closing a window, and the menu says so where it matters.
 */
import path from 'node:path';
import { Menu, Tray, clipboard } from 'electron';
import { ASSETS_DIR } from './assets-dir.js';

/** macOS draws a template image in the menu bar's own colours; elsewhere the icon is shown as is. */
const ICON = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';

/**
 * @param {{mcpUrl: string, attachedPid: number|null, onOpen: () => void, onQuit: () => void,
 *          onInstallUpdate: () => void}} options
 *   `attachedPid` is the Paddock the app is showing without having started it, which quitting and
 *   updating both leave running
 * @returns {{offerUpdate: (version: string) => void}} holding the Tray, which must stay referenced: a
 *   collected Tray disappears
 */
export function createTray({ mcpUrl, attachedPid, onOpen, onQuit, onInstallUpdate }) {
  const tray = new Tray(path.join(ASSETS_DIR, ICON));
  const stopsServices = attachedPid ? '' : ' — stops running services';
  let updateVersion = null;

  const render = () => {
    tray.setToolTip(updateVersion ? `Paddock — ${updateVersion} is ready to install` : 'Paddock');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Paddock', click: onOpen },
        { label: 'Copy MCP URL', click: () => clipboard.writeText(mcpUrl) },
        { type: 'separator' },
        ...(updateVersion
          ? [{ label: `Install ${updateVersion} and Restart${stopsServices}`, click: onInstallUpdate }]
          : []),
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
    offerUpdate(version) {
      updateVersion = version;
      render();
    },
  };
}
