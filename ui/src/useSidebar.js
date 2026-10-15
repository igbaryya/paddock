/**
 * Whether the sidebar is collapsed to an icon rail. Like the theme, it is how this screen looks, so
 * it lives in localStorage rather than in the manager's settings.
 *
 * index.html applies the stored choice before the first paint, so a collapsed rail never opens
 * wide for a frame and snaps shut.
 */
import { useCallback, useEffect, useState } from 'react';

/** Must match the inline script in index.html. */
const STORAGE_KEY = 'paddock.sidebar';

function readCollapsed() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** @returns {{collapsed: boolean, toggle: () => void}} */
export function useSidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
      // Not persisted, but still applied for this visit.
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  return { collapsed, toggle };
}
