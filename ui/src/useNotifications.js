/**
 * What the bell lists: a process that crashed or failed to start, and an update ready to install.
 *
 * Derived from the live application list rather than from a separate stream. A process counts once
 * per stop: the key carries `stoppedAt`, so a process that crashes again after a restart is a new
 * notification, while every refetch of the same crash is the same one. The list lives in memory for
 * this window only — the manager's own state is what survives a reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { exitSummary } from './format.js';

const PROBLEMS = new Set(['crashed', 'failed']);

/** Enough for a bad afternoon; older ones fall off rather than growing without bound. */
const MAX_ITEMS = 50;

/**
 * @typedef {{id: string, kind: 'process'|'update', title: string, detail: string|null,
 *            ts: number, applicationId?: string}} Notification
 */

/**
 * @param {object[]} applications ApplicationViews from the live state
 * @param {object|null} updateState the desktop updater's state, or null outside the app
 * @returns {{items: Notification[], unread: number, markRead: () => void, clear: () => void}}
 */
export function useNotifications(applications, updateState) {
  const [items, setItems] = useState([]);
  const [readAt, setReadAt] = useState(0);
  const seenRef = useRef(new Set());

  const add = useCallback((incoming) => {
    const fresh = incoming.filter((item) => !seenRef.current.has(item.id));
    if (!fresh.length) return;
    fresh.forEach((item) => seenRef.current.add(item.id));
    setItems((prev) => [...fresh, ...prev].sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS));
  }, []);

  useEffect(() => {
    const incoming = [];
    for (const application of applications) {
      for (const process of application.processes ?? []) {
        if (!PROBLEMS.has(process.status)) continue;
        const stopped = process.stoppedAt ? Date.parse(process.stoppedAt) : NaN;
        incoming.push({
          id: `process:${application.id}:${process.id}:${process.stoppedAt ?? process.status}`,
          kind: 'process',
          applicationId: application.id,
          title: `${process.name} ${process.status === 'failed' ? 'failed to start' : 'crashed'}`,
          detail: [application.name, process.lastError ?? exitSummary(process)].filter(Boolean).join(' · '),
          ts: Number.isFinite(stopped) ? stopped : Date.now(),
        });
      }
    }
    add(incoming);
  }, [applications, add]);

  useEffect(() => {
    if (updateState?.status !== 'ready' || !updateState.version) return;
    add([
      {
        id: `update:${updateState.version}`,
        kind: 'update',
        title: `Paddock ${updateState.version} is ready to install`,
        detail: 'Install it from Settings or the tray.',
        ts: Date.now(),
      },
    ]);
  }, [updateState, add]);

  const markRead = useCallback(() => setReadAt(Date.now()), []);
  // Cleared items stay in `seenRef`, so the same crash does not come straight back on the next refetch.
  const clear = useCallback(() => setItems([]), []);

  const unread = items.filter((item) => item.ts > readAt).length;
  return { items, unread, markRead, clear };
}
