/**
 * The dashboard's view of the app it runs in, as `window.paddockDesktop`. The main-process side, and
 * the shape of an update state, are in bridge.js and updates.js.
 *
 * CommonJS, because a sandboxed preload is not loaded as a module. The channel names repeat
 * bridge.js's for the same reason.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paddockDesktop', {
  /** @returns {Promise<string>} the app's version, which is the server's */
  getVersion: () => ipcRenderer.invoke('paddock:version'),
  /** @returns {Promise<object>} what the updater is doing right now */
  getUpdateState: () => ipcRenderer.invoke('paddock:update-state'),
  /** @returns {Promise<object>} the state the check left; a found update starts downloading */
  checkForUpdates: () => ipcRenderer.invoke('paddock:check-for-updates'),
  /** Stops every service the app's server runs, installs the ready update, and relaunches. */
  installUpdate: () => ipcRenderer.invoke('paddock:install-update'),
  /**
   * @param {(state: object) => void} listener called on every change
   * @returns {() => void} unsubscribes
   */
  onUpdateState: (listener) => {
    const relay = (_event, state) => listener(state);
    ipcRenderer.on('paddock:update-state-changed', relay);
    return () => ipcRenderer.removeListener('paddock:update-state-changed', relay);
  },
});
