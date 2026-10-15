/**
 * Keyboard shortcuts: what each one does, its default keys, and how a key press is read and drawn.
 *
 * A combination is a string such as `Mod+Shift+P`, modifiers always in the order Mod, Alt, Shift.
 * `Mod` is ⌘ on a Mac and Ctrl everywhere else, so one stored binding means the same gesture on
 * both. This module is pure — no DOM, no storage — so the rules for reading a key press can be
 * tested on their own; the bindings themselves live in useShortcuts.js.
 */

/**
 * Every rebindable action, in the order Settings lists them. `scope: 'application'` actions act on
 * the application whose page is open and do nothing anywhere else. `null` means unassigned.
 */
export const SHORTCUT_ACTIONS = [
  { id: 'palette', group: 'General', label: 'Search and commands', defaultCombo: 'Mod+K' },
  { id: 'newApplication', group: 'General', label: 'New application', defaultCombo: 'Mod+N' },
  { id: 'toggleSidebar', group: 'General', label: 'Collapse or expand the sidebar', defaultCombo: 'Mod+B' },
  { id: 'showShortcuts', group: 'General', label: 'Keyboard shortcuts', defaultCombo: 'Mod+/' },
  { id: 'goOverview', group: 'Go to', label: 'Applications', defaultCombo: 'Mod+Shift+O' },
  { id: 'goPorts', group: 'Go to', label: 'Local ports', defaultCombo: 'Mod+Shift+P' },
  { id: 'goSettings', group: 'Go to', label: 'Settings', defaultCombo: 'Mod+,' },
  { id: 'editApplication', group: 'Open application', label: 'Edit the application', defaultCombo: 'Mod+E', scope: 'application' },
  { id: 'openLogs', group: 'Open application', label: 'Open its logs', defaultCombo: 'Mod+Shift+L', scope: 'application' },
  { id: 'openTerminal', group: 'Open application', label: 'Open a terminal', defaultCombo: 'Mod+J', scope: 'application' },
  { id: 'startApplication', group: 'Open application', label: 'Start it', defaultCombo: null, scope: 'application' },
  { id: 'stopApplication', group: 'Open application', label: 'Stop it', defaultCombo: null, scope: 'application' },
  { id: 'restartApplication', group: 'Open application', label: 'Restart it', defaultCombo: null, scope: 'application' },
];

const ACTION_IDS = new Set(SHORTCUT_ACTIONS.map((action) => action.id));

export const DEFAULT_BINDINGS = Object.freeze(
  Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultCombo]))
);

/** Keys read by position, so Shift and ⌥ — which change the character typed — do not change them. */
const PUNCTUATION_CODES = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
};

const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

const FUNCTION_KEY = /^F([1-9]|1[0-9])$/;

/**
 * The key a press is about, or null for a modifier on its own (the user is still pressing).
 * The typed character wins for letters and digits so a non-QWERTY layout gets the letter on its
 * keycap; when ⌥ or Shift turned that into something else (⌥P is "π"), the key's position decides.
 * @param {{key: string, code?: string}} event
 * @returns {string|null}
 */
export function keyOf(event) {
  const { key = '', code = '' } = event;
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  const letter = code.match(/^Key([A-Z])$/) ?? code.match(/^Digit([0-9])$/);
  if (letter) return letter[1];
  if (PUNCTUATION_CODES[code]) return PUNCTUATION_CODES[code];
  if (code === 'Space' || key === ' ') return 'Space';
  if (NAMED_KEYS.has(key) || FUNCTION_KEY.test(key)) return key;
  return null;
}

/**
 * @param {{key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean,
 *          shiftKey?: boolean}} event
 * @returns {string|null} the canonical combination, or null while only modifiers are down
 */
export function comboFromEvent(event) {
  const key = keyOf(event);
  if (!key) return null;
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** The key is always last. `+` itself is never one: `=` is read by position, Shift or not. */
function split(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  return { mods: new Set(parts), key };
}

const MODIFIERS = ['Mod', 'Alt', 'Shift'];
const PUNCTUATION = new Set(Object.values(PUNCTUATION_CODES));

/** @param {unknown} combo @returns {boolean} whether it is a combination comboFromEvent could produce */
export function isCombo(combo) {
  if (typeof combo !== 'string' || !combo) return false;
  const parts = combo.split('+');
  const key = parts.pop();
  const ordered = MODIFIERS.filter((mod) => parts.includes(mod));
  if (ordered.length !== parts.length || ordered.join('+') !== parts.join('+')) return false;
  return (
    /^[A-Z0-9]$/.test(key) || PUNCTUATION.has(key) || key === 'Space' ||
    NAMED_KEYS.has(key) || FUNCTION_KEY.test(key)
  );
}

const MAC_KEYS = {
  Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: 'Space',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/**
 * How a combination is drawn: `⌘⇧P` on a Mac, `Ctrl+Shift+P` elsewhere — each platform's own way.
 * @param {string|null} combo
 * @param {boolean} mac
 * @returns {string}
 */
export function formatCombo(combo, mac) {
  if (!combo) return '';
  const { mods, key } = split(combo);
  if (mac) {
    return `${mods.has('Mod') ? '⌘' : ''}${mods.has('Alt') ? '⌥' : ''}${mods.has('Shift') ? '⇧' : ''}${MAC_KEYS[key] ?? key}`;
  }
  return [mods.has('Mod') && 'Ctrl', mods.has('Alt') && 'Alt', mods.has('Shift') && 'Shift', key]
    .filter(Boolean)
    .join('+');
}

/**
 * Combinations the window or the text fields under the cursor already answer to. Taking one would
 * either never fire or break something everyone relies on.
 */
const RESERVED = {
  'Mod+Q': 'quits',
  'Mod+W': 'closes the window',
  'Mod+H': 'hides the app',
  'Mod+M': 'minimises the window',
  'Mod+R': 'reloads the page',
  'Mod+Shift+R': 'reloads the page',
  'Mod+T': 'opens a new tab',
  'Mod+C': 'copies',
  'Mod+V': 'pastes',
  'Mod+X': 'cuts',
  'Mod+A': 'selects all',
  'Mod+Z': 'undoes',
  'Mod+Shift+Z': 'redoes',
  'Mod+0': 'resets the zoom',
  'Mod+=': 'zooms in',
  'Mod+-': 'zooms out',
  'Mod+Alt+I': 'opens the developer tools',
};

/**
 * Why a combination cannot be used, or null when it can.
 * @param {string} combo
 * @param {boolean} mac
 * @returns {string|null}
 */
export function rejectCombo(combo, mac) {
  const { mods, key } = split(combo);
  const shown = formatCombo(combo, mac);
  if (!mods.has('Mod') && !mods.has('Alt') && !FUNCTION_KEY.test(key)) {
    return `Add ${mac ? '⌘ or ⌥' : 'Ctrl or Alt'} — without one, ${shown} would fire as you type.`;
  }
  if (mods.size === 1 && mods.has('Mod') && /^[1-9]$/.test(key)) {
    return `${formatCombo('Mod+1', mac)}–${formatCombo('Mod+9', mac)} switch between applications.`;
  }
  if (RESERVED[combo]) return `${shown} already ${RESERVED[combo]}.`;
  return null;
}

/**
 * The stored bindings, made safe to use: unknown actions dropped, anything unreadable back to its
 * default, and no combination bound twice — the earlier action in the list keeps it.
 * @param {unknown} stored
 * @returns {Record<string, string|null>}
 */
export function normalizeBindings(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const bindings = { ...DEFAULT_BINDINGS };
  for (const [id, combo] of Object.entries(source)) {
    if (!ACTION_IDS.has(id)) continue;
    if (combo === null || isCombo(combo)) bindings[id] = combo;
  }
  const taken = new Set();
  for (const { id } of SHORTCUT_ACTIONS) {
    const combo = bindings[id];
    if (!combo) continue;
    if (taken.has(combo)) bindings[id] = null;
    else taken.add(combo);
  }
  return bindings;
}

/**
 * Only what differs from the defaults is stored, so a default changed in a later release reaches
 * everyone who never touched that shortcut.
 * @param {Record<string, string|null>} bindings
 */
export function changedFromDefaults(bindings) {
  return Object.fromEntries(
    Object.entries(bindings).filter(([id, combo]) => DEFAULT_BINDINGS[id] !== combo)
  );
}

/**
 * @param {Record<string, string|null>} bindings
 * @param {string} combo
 * @param {string} [except] the action being rebound, which may keep its own keys
 * @returns {string|null} the action already bound to `combo`
 */
export function actionFor(bindings, combo, except) {
  if (!combo) return null;
  return SHORTCUT_ACTIONS.find(({ id }) => id !== except && bindings[id] === combo)?.id ?? null;
}

/** @param {string} id */
export const actionById = (id) => SHORTCUT_ACTIONS.find((action) => action.id === id) ?? null;
