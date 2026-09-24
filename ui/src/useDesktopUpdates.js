/**
 * The desktop app's version and update state, read through the bridge its preload exposes as
 * `window.paddockDesktop`. Outside the desktop app — a browser on a checkout — there is no bridge,
 * and this returns null so every caller hides its version and update controls outright rather than
 * showing ones that cannot work.
 *
 * The tray reads the same state from the same updater, so the dashboard and the tray never disagree
 * about whether an update is ready.
 */
import { useCallback, useEffect, useState } from 'react';

/** @returns {typeof window.paddockDesktop|null} */
const bridge = () => (typeof window !== 'undefined' && window.paddockDesktop) || null;

/**
 * @returns {null | {version: string|null, state: object|null, check: () => Promise<void>,
 *                   install: () => Promise<void>}}
 */
export function useDesktopUpdates() {
  const desktop = bridge();
  const [version, setVersion] = useState(null);
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!desktop) return undefined;
    let live = true;
    desktop.getVersion().then((next) => live && setVersion(next), () => {});
    desktop.getUpdateState().then((next) => live && setState(next), () => {});
    const unsubscribe = desktop.onUpdateState((next) => live && setState(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [desktop]);

  const check = useCallback(async () => {
    setState(await desktop.checkForUpdates());
  }, [desktop]);

  const install = useCallback(() => desktop.installUpdate(), [desktop]);

  return desktop ? { version, state, check, install } : null;
}
