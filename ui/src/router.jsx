/**
 * A three-route router over the History API.
 *
 * Real URLs rather than hash fragments, because an application's page is worth linking to and
 * pasting into a ticket — the manager already serves index.html for any extension-less path, so a
 * deep link survives a refresh.
 *
 * This is deliberately not a routing library. There are three routes with one parameter between
 * them; a dependency would be more code to reason about than the twenty lines below, and the whole
 * surface is `useRoute`, `navigate` and `Link`, which is what a library would be swapped in for.
 */
import { useCallback, useEffect, useState } from 'react';

/** pushState does not fire popstate, so navigations are announced on this. */
const NAVIGATED = 'paddock:navigated';

export const paths = {
  overview: () => '/',
  application: (id) => `/applications/${encodeURIComponent(id)}`,
  ports: () => '/ports',
};

/** @param {string} pathname @returns {{name: string, applicationId?: string}} */
function parse(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { name: 'overview' };
  if (segments[0] === 'ports' && segments.length === 1) return { name: 'ports' };
  if (segments[0] === 'applications' && segments.length === 2) {
    return { name: 'application', applicationId: decodeURIComponent(segments[1]) };
  }
  return { name: 'not-found' };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.pathname));

  useEffect(() => {
    const sync = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATED, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATED, sync);
    };
  }, []);

  return route;
}

/** @param {string} to @param {{replace?: boolean}} [options] */
export function navigate(to, { replace = false } = {}) {
  if (to === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new Event(NAVIGATED));
  window.scrollTo(0, 0);
}

/**
 * An anchor, not a button with a click handler: a link the browser cannot see is one you cannot
 * middle-click, copy, or open in a second tab — and a developer comparing two applications will do
 * exactly that. Modified clicks are left to the browser.
 * @param {{to: string, children: any, className?: string}} props
 */
export function Link({ to, children, ...rest }) {
  const onClick = useCallback(
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
    [to]
  );
  return (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
