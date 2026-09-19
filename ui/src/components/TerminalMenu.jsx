/**
 * Which terminal to show or open — open sessions first, then one entry per place a new shell
 * may be started. The same list the header dropdown and the panel's New control both need.
 */
import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import StatusDot from './StatusDot.jsx';
import { listTerminals } from '../api.js';

/**
 * @param {{applicationId: string, onPickSession: (sessionId: string) => void,
 *          onPickTarget: (processId: string) => void, onClose: () => void,
 *          showSessions?: boolean}} props `showSessions` is false in the docked panel — open shells
 *   are listed in the sidebar instead.
 */
export default function TerminalMenu({
  applicationId,
  onPickSession,
  onPickTarget,
  onClose,
  showSessions = true,
}) {
  const [support, setSupport] = useState(null);
  const [targets, setTargets] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);
  const menuRef = useRef(null);
  const labelId = useId();

  useEffect(() => {
    const controller = new AbortController();
    listTerminals(applicationId, controller.signal).then(
      (state) => {
        setSupport(state.support);
        setTargets(state.targets);
        setSessions(state.sessions);
      },
      (err) => {
        if (err.name !== 'AbortError') setError(err.message);
      }
    );
    return () => controller.abort();
  }, [applicationId]);

  useEffect(() => {
    menuRef.current?.querySelector('button')?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loading = support === null && !error;
  const unavailable = support && !support.available;

  return (
    <div
      className="menu terminal-menu"
      role="menu"
      aria-labelledby={labelId}
      ref={menuRef}
    >
      <div className="terminal-menu-head" id={labelId}>
        <Icon name="terminal" />
        <span>Terminal</span>
      </div>

      {error && <p className="terminal-menu-note danger">{error}</p>}
      {loading && <p className="terminal-menu-note">Loading…</p>}
      {unavailable && <p className="terminal-menu-note">{support.reason}</p>}

      {!loading && !unavailable && !error && (
        <div className="terminal-menu-scroll">
          {showSessions && sessions.length > 0 && (
            <section className="terminal-menu-section" aria-label="Open terminals">
              <h3>Open</h3>
              <ul>
                {sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      role="menuitem"
                      className="terminal-menu-row"
                      onClick={() => onPickSession(session.id)}
                    >
                      <span className="terminal-menu-tile" aria-hidden="true">
                        <StatusDot status={session.running === false ? 'stopped' : 'running'} />
                      </span>
                      <span className="terminal-menu-copy">
                        <span className="terminal-menu-name">
                          {session.processName ?? 'Shell'}
                          {session.running === false && (
                            <span className="terminal-menu-badge">ended</span>
                          )}
                        </span>
                        <span className="terminal-menu-path" title={session.cwd}>
                          {session.cwd}
                        </span>
                      </span>
                      <Icon name="chevron" className="terminal-menu-arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {targets.length > 0 && (
            <section className="terminal-menu-section" aria-label="New terminal">
              <h3>New terminal in</h3>
              <ul>
                {targets.map((target) => (
                  <li key={target.processId}>
                    <button
                      type="button"
                      role="menuitem"
                      className="terminal-menu-row is-new"
                      onClick={() => onPickTarget(target.processId)}
                    >
                      <span className="terminal-menu-tile is-new" aria-hidden="true">
                        <Icon name="plus" />
                      </span>
                      <span className="terminal-menu-copy">
                        <span className="terminal-menu-name">{target.processName}</span>
                        <span className="terminal-menu-path" title={target.cwd}>
                          {target.cwd}
                        </span>
                      </span>
                      <Icon name="plus" className="terminal-menu-action" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(!showSessions || sessions.length === 0) && targets.length === 0 && (
            <p className="terminal-menu-note">No process configured — add one first.</p>
          )}
        </div>
      )}
    </div>
  );
}
