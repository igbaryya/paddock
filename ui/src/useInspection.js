/**
 * What the manager can tell the process form about the directory a command will run in: the scripts
 * that directory's package.json declares, and the .env files sitting next to it.
 *
 * Debounced, because the directory is a text field and most of the paths typed into one have never
 * existed. Cleared the moment the directory changes rather than left on screen: the previous
 * directory's scripts shown against a new path are not stale, they are wrong.
 *
 * A failed inspection is not an error anyone is told about. The field has its own validation and the
 * manager has the last word at save time; a red message here would be a second opinion about a path
 * the user is still in the middle of typing.
 */
import { useEffect, useState } from 'react';
import { inspectDirectory } from './api.js';

const DEBOUNCE_MS = 400;

const NOTHING = { loading: false, inspection: null };

/**
 * @param {string|null} directory an absolute path, or null when there is nothing worth asking about
 *   — deciding that is the caller's job, since it is the caller that validates the field
 * @returns {{loading: boolean, inspection: object|null}}
 */
export function useInspection(directory) {
  const [state, setState] = useState(NOTHING);

  useEffect(() => {
    if (!directory) {
      setState(NOTHING);
      return undefined;
    }
    setState({ loading: true, inspection: null });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      inspectDirectory(directory, controller.signal)
        .then((inspection) => setState({ loading: false, inspection }))
        .catch(() => {
          if (!controller.signal.aborted) setState(NOTHING);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [directory]);

  return state;
}
