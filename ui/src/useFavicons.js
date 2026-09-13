/**
 * The favicon image of every process that has one, keyed by process id.
 *
 * The application list carries only each icon's `fetchedAt`, and it is refetched on every status
 * change. The images themselves are fetched again only when that set of versions actually changes —
 * a new icon found, one replaced, one removed — so a busy dashboard does not re-download the same
 * few kilobytes of base64 every time a process starts.
 */
import { useEffect, useState } from 'react';
import { listFavicons } from './api.js';

/** A fingerprint of which icons exist and which version of each — the only thing worth refetching on. */
const versionsOf = (applications) =>
  applications
    .flatMap((application) => application.processes)
    .filter((process) => process.favicon)
    .map((process) => `${process.id}@${process.favicon.fetchedAt}`)
    .sort()
    .join(',');

/**
 * @param {object[]} applications
 * @returns {Record<string, {dataUrl: string, sourceUrl: string}>}
 */
export function useFavicons(applications) {
  const [favicons, setFavicons] = useState({});
  const versions = versionsOf(applications);

  useEffect(() => {
    if (!versions) {
      setFavicons({});
      return undefined;
    }
    const controller = new AbortController();
    listFavicons(controller.signal)
      .then((body) => setFavicons(body.favicons))
      // A missing icon is decoration, not an error: the cards keep whatever they last showed.
      .catch(() => {});
    return () => controller.abort();
  }, [versions]);

  return favicons;
}
