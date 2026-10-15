/**
 * The keyboard shortcuts in effect, and the user's changes to them.
 *
 * Like the theme, they belong to this browser and live in localStorage: they are how this screen is
 * driven, not a property of Paddock. Only the changes are stored (see `changedFromDefaults`).
 *
 * A tiny external store rather than component state, because the shell's key listener, the sidebar's
 * hints, the palette and the Settings tab all show the same bindings and must never disagree.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_BINDINGS, changedFromDefaults, normalizeBindings } from './shortcuts.js';

const STORAGE_KEY = 'paddock.shortcuts';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function readBindings() {
  try {
    return normalizeBindings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

let snapshot = { bindings: readBindings(), recording: false };
const listeners = new Set();

function publish(next) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

/** @param {Record<string, string|null>} bindings */
function save(bindings) {
  const normalized = normalizeBindings(bindings);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(changedFromDefaults(normalized)));
  } catch {
    // Not persisted, but still in effect for this visit.
  }
  publish({ bindings: normalized });
}

/**
 * Bind `combo` to `id`. Whoever had it loses it — the caller has already asked whether to take it.
 * @param {string} id @param {string|null} combo `null` leaves the action unassigned
 */
export function setShortcut(id, combo) {
  const next = { ...snapshot.bindings };
  if (combo) {
    for (const [other, bound] of Object.entries(next)) if (bound === combo) next[other] = null;
  }
  next[id] = combo;
  save(next);
}

/** @param {string} id */
export const resetShortcut = (id) => setShortcut(id, DEFAULT_BINDINGS[id]);

export const resetAllShortcuts = () => save({ ...DEFAULT_BINDINGS });

/**
 * While a shortcut is being changed in Settings, no shortcut runs: ⌘N there must record ⌘N, not
 * open the new-application form underneath, and Escape cancels the change rather than leaving.
 * @param {boolean} recording
 */
export function setRecording(recording) {
  if (snapshot.recording !== recording) publish({ recording });
}

/** For the key listener, which reads the current state on each press rather than re-subscribing. */
export const getShortcuts = () => snapshot;

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  publish({ bindings: readBindings() });
});

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** @returns {{bindings: Record<string, string|null>, recording: boolean}} */
export function useShortcuts() {
  return useSyncExternalStore(subscribe, getShortcuts);
}
