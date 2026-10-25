/**
 * Paddock's mark: the image the user replaced it with, or public/favicon.svg.
 *
 * A tiny external store, like the theme, because the sidebar, the browser tab, Settings and the
 * setup wizard all show the same mark and must never disagree. Unlike the theme it belongs to the
 * manager rather than this browser — every dashboard on this Paddock shows the same one — so it is
 * read from there on each (re)connect, and a new one is shown only once the manager has kept it.
 */
import { useSyncExternalStore } from 'react';
import * as api from './api.js';

export const DEFAULT_LOGO = '/favicon.svg';

// Replaced, never mutated: useSyncExternalStore re-renders on a new reference and only then.
let snapshot = { logo: null };
const listeners = new Set();

/** The tab follows the sidebar. index.html declares Paddock's mark, so a reset is a return to it. */
function apply(logo) {
  snapshot = { logo };
  const link = document.querySelector('link[rel="icon"]');
  if (link) {
    link.type = logo?.contentType ?? 'image/svg+xml';
    link.href = logo?.dataUrl ?? DEFAULT_LOGO;
  }
  listeners.forEach((listener) => listener());
}

/** A failed read keeps what is on screen: the mark is not worth an error of its own. */
export const refreshBranding = () => api.getBranding().then(({ logo }) => apply(logo), () => {});

/** @param {string} dataUrl rejects with the manager's own reason, for the picker to show */
export async function setLogo(dataUrl) {
  apply((await api.setLogo(dataUrl)).logo);
}

export async function resetLogo() {
  apply((await api.resetLogo()).logo);
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => snapshot;

/** @returns {{logo: {dataUrl: string, contentType: string, bytes: number, updatedAt: string}|null}} */
export function useBranding() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
