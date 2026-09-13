/**
 * Browse the machine for a directory, inline underneath the field it fills in. This is the fallback:
 * Browse opens the operating system's own dialog first, and this only appears on a machine that
 * cannot show one.
 *
 * Inline rather than a dialog on top of the form: two modals would stack two Escape handlers and two
 * focus traps, and Escape would then close the form the user is halfway through filling in.
 *
 * The manager decides where the picker actually is. `dir` below is only what was last *asked* for,
 * and every path the picker navigates to afterwards comes back from the server already resolved —
 * so nothing here has to normalise a path, which is exactly the job a browser has no business doing.
 */
import { useEffect, useState } from 'react';
import { listDirectory } from '../api.js';

const SEPARATOR = /[/\\]/;

/**
 * Every prefix of the path, so each crumb is somewhere to jump back to. Split rather than walked up:
 * there is no path module in a browser, and both separators have to work because the manager may be
 * running on Windows.
 */
function crumbsOf(dir) {
  const separator = dir.includes('\\') ? '\\' : '/';
  const parts = dir.split(SEPARATOR);
  // '' before a leading separator on POSIX, 'C:' on Windows — either way the first crumb is the root.
  const root = parts[0] === '' ? separator : parts[0] + separator;
  const crumbs = [{ path: root, name: root }];
  let prefix = root;
  for (const part of parts.slice(1).filter(Boolean)) {
    prefix = prefix.endsWith(separator) ? prefix + part : prefix + separator + part;
    crumbs.push({ path: prefix, name: part });
  }
  return crumbs;
}

/** @param {{listing: object, onOpen: (path: string) => void}} props */
function Crumbs({ listing, onOpen }) {
  const crumbs = crumbsOf(listing.path);
  return (
    <nav className="picker-crumbs" aria-label="Current path">
      {crumbs.map((crumb, index) => (
        <button
          key={crumb.path}
          type="button"
          // The root crumb is already spelled '/' (or 'C:\'), so the one after it must not have a
          // separator drawn in front of it as well.
          className={index === 0 ? 'crumb crumb-root' : 'crumb'}
          aria-current={index === crumbs.length - 1 ? 'location' : undefined}
          onClick={() => onOpen(crumb.path)}
        >
          {crumb.name}
        </button>
      ))}
    </nav>
  );
}

/**
 * @param {{start: string, onPick: (path: string) => void, onCancel: () => void}} props
 *   `start` may be empty, a half-typed path or a path that has since been deleted; all three are the
 *   server's problem, and it answers the first by opening at the user's home directory.
 */
export default function DirectoryPicker({ start, onPick, onCancel }) {
  const [dir, setDir] = useState(start);
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setFilter('');
    listDirectory(dir, controller.signal)
      .then(setListing)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [dir]);

  if (error) {
    return (
      <div className="picker">
        <p className="field-error" role="alert">
          {error}
        </p>
        <div className="picker-actions">
          <button type="button" className="btn small ghost" onClick={onCancel}>
            Close
          </button>
          <button type="button" className="btn small" onClick={() => setDir('')}>
            Start at home
          </button>
        </div>
      </div>
    );
  }

  if (!listing) return <div className="picker picker-loading">Reading…</div>;

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? listing.entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    : listing.entries;

  return (
    <div className="picker">
      <Crumbs listing={listing} onOpen={setDir} />
      <input
        type="text"
        className="picker-filter"
        value={filter}
        placeholder="Filter this folder"
        aria-label="Filter directories"
        spellCheck={false}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ul className="picker-list">
        {listing.parent && (
          <li>
            <button type="button" className="picker-entry" onClick={() => setDir(listing.parent)}>
              <span className="picker-up">..</span>
            </button>
          </li>
        )}
        {visible.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="picker-entry" onClick={() => setDir(entry.path)}>
              {entry.name}
            </button>
          </li>
        ))}
        {!visible.length && <li className="picker-empty">No subfolders here.</li>}
      </ul>
      {/* The filter only sees what came back, so a truncated listing has to say so or it is a lie. */}
      {listing.truncated && <p className="hint">Only the first folders in this directory are shown.</p>}
      <div className="picker-actions">
        <span className="picker-here mono" title={listing.path}>
          {listing.path}
        </span>
        <button type="button" className="btn small ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={() => onPick(listing.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}
