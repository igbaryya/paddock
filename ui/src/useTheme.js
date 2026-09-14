/**
 * The colour theme: which one the user chose, and which one is actually on screen.
 *
 * "System" is a real third choice, not the absence of one — it keeps following the OS, so a laptop
 * that switches to dark at sunset takes the dashboard with it. The choice belongs to this browser
 * and lives in localStorage: it is how this screen looks, not a property of Paddock, so it has no
 * place in the manager's settings beside Start at login.
 *
 * index.html applies the stored theme before the first paint; this module keeps it applied after.
 * It is a tiny external store rather than component state because more than one control shows the
 * same choice, and they must never disagree.
 */
import { useSyncExternalStore } from 'react';

export const THEMES = ['system', 'light', 'dark'];

/** Must match the inline script in index.html, which reads it before this module has loaded. */
const STORAGE_KEY = 'paddock.theme';

const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)');

function readPreference() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    // Storage can be blocked outright by a privacy setting; following the system is the right
    // answer when the stored choice cannot be read.
    return 'system';
  }
}

const resolve = (preference) =>
  preference === 'system' ? (systemPrefersLight.matches ? 'light' : 'dark') : preference;

let preference = readPreference();
// Replaced, never mutated: useSyncExternalStore re-renders on a new reference and only then.
let snapshot = { preference, resolved: resolve(preference) };
const listeners = new Set();

function apply() {
  snapshot = { preference, resolved: resolve(preference) };
  const root = document.documentElement;
  root.dataset.theme = snapshot.resolved;
  // Native controls — scrollbars, select menus, the search field's clear button — follow
  // color-scheme, not the CSS tokens.
  root.style.colorScheme = snapshot.resolved;
  listeners.forEach((listener) => listener());
}

/** @param {'system'|'light'|'dark'} next */
export function setThemePreference(next) {
  if (!THEMES.includes(next) || next === preference) return;
  preference = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted, but still applied for this visit.
  }
  apply();
}

// The OS flipping only matters while following it; an explicit choice is left alone.
systemPrefersLight.addEventListener('change', () => {
  if (preference === 'system') apply();
});

// Another tab changed it: follow, so two open dashboards never show different themes.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  preference = readPreference();
  apply();
});

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => snapshot;

/** @returns {{preference: 'system'|'light'|'dark', resolved: 'light'|'dark'}} */
export function useTheme() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

apply();
