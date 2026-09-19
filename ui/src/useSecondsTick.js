/**
 * A clock that ticks once a second, for the places that count elapsed time.
 *
 * Uptime that never moves reads as a frozen dashboard, and the manager is not asked again just to
 * advance a counter it does not own — so this re-renders the one component holding the whole canvas
 * rather than each card keeping an interval of its own.
 */
import { useEffect, useState } from 'react';

/** @returns {number} the current epoch milliseconds, refreshed every second */
export function useSecondsTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
