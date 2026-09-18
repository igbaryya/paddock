/**
 * Start at login, for the app. The entry opens the app itself — a Login Item on macOS, a value under
 * the Run key on Windows — and only Electron can register it, from this process. The server's
 * Settings screen asks for it over the utility-process port (platform/desktop.js is the other half)
 * and gets answers in the shape platform/ gives, so nothing above that layer can tell the difference.
 */
import { app } from 'electron';

/** Windows keeps no record of why an app was opened, so the entry says so itself. */
const OPENED_AT_LOGIN_ARG = '--opened-at-login';

/** Passed to both get and set: on Windows an entry only counts as this one if its arguments match. */
const ENTRY = { args: [OPENED_AT_LOGIN_ARG] };

/** Where the user finds the entry outside Paddock, per platform that has one. */
const LOCATIONS = {
  darwin: 'System Settings → General → Login Items',
  win32: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
};

/** Read once the app is ready; a login opens the app to the tray rather than to a window. */
export const openedAtLogin = () =>
  process.platform === 'darwin'
    ? app.getLoginItemSettings().wasOpenedAtLogin
    : process.argv.includes(OPENED_AT_LOGIN_ARG);

/**
 * A development copy has no entry: on macOS the one registered would open bare Electron, not this
 * app, and a checkout already has its own login agent.
 * @returns {string|null}
 */
function unsupportedReason() {
  if (!LOCATIONS[process.platform]) return 'Start at login is available in the macOS and Windows apps.';
  if (!app.isPackaged) return 'Start at login needs the installed app; this copy runs from a checkout.';
  return null;
}

/**
 * The OS can hold an entry back after it is written, and only the user can release it, in the OS.
 * @param {Electron.LoginItemSettings} settings
 */
function heldBackNote(settings) {
  if (settings.status === 'requires-approval') {
    return 'macOS is waiting for you to allow Paddock in System Settings → General → Login Items.';
  }
  if (process.platform === 'win32' && settings.openAtLogin && !settings.executableWillLaunchAtLogin) {
    return 'Windows has Paddock turned off under Settings → Apps → Startup.';
  }
  return null;
}

function status() {
  const reason = unsupportedReason();
  if (reason) {
    return { supported: false, reason, note: null, installed: false, location: '', startNowCommand: null };
  }
  const settings = app.getLoginItemSettings(ENTRY);
  return {
    supported: true,
    reason: null,
    note: heldBackNote(settings),
    // Written but awaiting approval is still on: the switch says what the user asked for.
    installed: settings.openAtLogin || settings.status === 'requires-approval',
    location: LOCATIONS[process.platform],
    // Opening the app is what starts it, and it is already open.
    startNowCommand: null,
  };
}

/** @param {boolean} openAtLogin */
function setOpenAtLogin(openAtLogin) {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  app.setLoginItemSettings({ ...ENTRY, openAtLogin });
}

const ACTIONS = {
  'loginItem.status': status,
  'loginItem.enable': () => setOpenAtLogin(true),
  'loginItem.disable': () => setOpenAtLogin(false),
};

/**
 * Answers the server's requests. An action this app does not know is an error, not a silence: a
 * newer server beside an older app should say so rather than time out.
 * @param {string} action
 */
export async function handleServerRequest(action) {
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`this version of the desktop app does not handle ${action}`);
  return handler();
}
