/**
 * The terminals of one application: one shell on screen, the rest listed in a sidebar, and the
 * control that opens another.
 *
 * Every terminal stays mounted, and only the chosen one is shown. That is the whole reason this
 * component exists rather than rendering one `Terminal` at a time: unmounting a tab would dispose
 * its screen, and coming back to a terminal to find the output of the command you left running
 * replaced by a fresh prompt is the one thing a tabbed terminal must never do.
 *
 * The sessions themselves belong to the manager and outlive this panel, so opening it lists what is
 * already running rather than starting anything. Closing the panel leaves every shell alone.
 */
import { useEffect, useRef, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import LogViewer from './LogViewer.jsx';
import Terminal from './Terminal.jsx';
import TerminalMenu from './TerminalMenu.jsx';
import { closeTerminal, listTerminals, openTerminal } from '../api.js';

/** @type {const} */
const PANEL_TABS = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'output', label: 'Output' },
];

/** @param {string} cwd */
function cwdLeaf(cwd) {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/**
 * @param {{application: object, logs: object[], onClearLogs: () => void,
 *          request?: {kind: 'session', sessionId: string}|{kind: 'new', processId: string}|null,
 *          onRequestHandled?: () => void, onClose?: () => void}} props
 */
export default function TerminalPanel({
  application,
  logs,
  onClearLogs,
  request = null,
  onRequestHandled,
  onClose,
}) {
  const [support, setSupport] = useState(null);
  const [targets, setTargets] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [panelTab, setPanelTab] = useState('terminal');
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const menuAnchorRef = useRef(null);
  const handledRequest = useRef(null);

  useEffect(() => {
    handledRequest.current = null;
    const controller = new AbortController();
    listTerminals(application.id, controller.signal).then(
      (state) => {
        setSupport(state.support);
        setTargets(state.targets);
        setSessions(state.sessions);
        setChosen(state.sessions.at(-1)?.id ?? null);
      },
      (err) => {
        if (err.name !== 'AbortError') setError(err.message);
      }
    );
    return () => controller.abort();
  }, [application.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event) => {
      if (menuAnchorRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onPointerDown);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  const forget = (sessionId) =>
    setSessions((open) => open.filter((session) => session.id !== sessionId));

  const markExited = (sessionId) =>
    setSessions((open) =>
      open.map((session) => (session.id === sessionId ? { ...session, running: false } : session))
    );

  const open = async (processId) => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      const session = await openTerminal(application.id, { processId });
      setSessions((current) => [...current, session]);
      setChosen(session.id);
      setPanelTab('terminal');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!request || support === null || !support.available) return;
    const key = request.kind === 'session' ? `s:${request.sessionId}` : `n:${request.processId}`;
    if (handledRequest.current === key) return;

    if (request.kind === 'session') {
      const match = sessions.find((session) => session.id === request.sessionId);
      if (!match) {
        if (sessions.length === 0) return;
      } else {
        setChosen(match.id);
      }
      setPanelTab('terminal');
      handledRequest.current = key;
      onRequestHandled?.();
      return;
    }

    handledRequest.current = key;
    open(request.processId).finally(() => onRequestHandled?.());
  }, [request, support, sessions, onRequestHandled]);

  const close = async (sessionId) => {
    const remaining = sessions.filter((session) => session.id !== sessionId);
    if (chosen === sessionId) setChosen(remaining.at(-1)?.id ?? null);
    forget(sessionId);
    await closeTerminal(sessionId).catch(() => {});
  };

  if (error && support === null) {
    return <EmptyState icon="alert" title="Could not reach the terminals">{error}</EmptyState>;
  }
  if (support === null) return <p className="empty-inline">Loading…</p>;

  if (!support.available) {
    return (
      <EmptyState icon="alert" title="No terminal on this installation">
        {support.reason}
      </EmptyState>
    );
  }

  const active = sessions.find((session) => session.id === chosen) ?? sessions.at(-1) ?? null;
  const onTerminal = panelTab === 'terminal';

  return (
    <section className="panel terminals" aria-label="Terminals">
      <div className="panel-head terminal-head">
        <div className="terminal-head-tabs" role="tablist" aria-label="Panel">
          {PANEL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={panelTab === tab.id}
              className={`terminal-head-tab${panelTab === tab.id ? ' selected' : ''}`}
              onClick={() => setPanelTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {active && (
          <span className="terminal-head-session">
            <Icon name={onTerminal ? 'terminal' : 'logs'} size={14} />
            <span>{active.processName ?? 'Shell'}</span>
          </span>
        )}
        <span className="spacer" />
        {onTerminal && (
          <div className="terminal-actions">
            <div className="menu-anchor" ref={menuAnchorRef}>
              <IconButton
                icon="plus"
                label="New terminal"
                className="small ghost"
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((was) => !was)}
              />
              {menuOpen && (
                <TerminalMenu
                  applicationId={application.id}
                  showSessions={false}
                  onPickSession={() => {}}
                  onPickTarget={open}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </div>
            {active && (
              <IconButton
                icon="trash"
                label="Close terminal"
                className="small ghost"
                onClick={() => close(active.id)}
              />
            )}
          </div>
        )}
        {onClose && (
          <IconButton icon="close" label="Close panel" className="small ghost" onClick={onClose} />
        )}
      </div>

      {error && (
        <p className="notice danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      {sessions.length === 0 ? (
        <EmptyState icon="terminal" title="No terminal open">
          Use the terminal menu in the toolbar to pick a shell or open a new one in a repository.
        </EmptyState>
      ) : (
        <div className="terminal-body">
          <div className="terminal-main">
            <div className="terminal-stack" hidden={!onTerminal}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="terminal-pane"
                  role="tabpanel"
                  hidden={session.id !== active?.id}
                >
                  <Terminal
                    sessionId={session.id}
                    active={session.id === active?.id && onTerminal}
                    onExit={() => markExited(session.id)}
                    onGone={() => {
                      const remaining = sessions.filter((item) => item.id !== session.id);
                      if (chosen === session.id) setChosen(remaining.at(-1)?.id ?? null);
                      forget(session.id);
                    }}
                  />
                </div>
              ))}
            </div>

            {!onTerminal && active?.processId && (
              <LogViewer
                embedded
                application={application}
                logs={logs}
                processId={active.processId}
                onClear={onClearLogs}
              />
            )}
            {!onTerminal && active && !active.processId && (
              <EmptyState icon="logs" title="No service linked">
                This shell is not tied to a managed process, so there is nothing to tail.
              </EmptyState>
            )}
          </div>

          <aside className="terminal-sessions" aria-label="Open terminals">
            {sessions.map((session) => {
              const selected = session.id === active?.id;
              return (
                <button
                  key={session.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`terminal-session${selected ? ' selected' : ''}${
                    session.running === false ? ' ended' : ''
                  }`}
                  title={session.cwd}
                  onClick={() => setChosen(session.id)}
                >
                  <Icon name="terminal" size={14} />
                  <span className="terminal-session-copy">
                    <span className="terminal-session-name">{session.processName ?? 'Shell'}</span>
                    <span className="terminal-session-path">{cwdLeaf(session.cwd)}</span>
                  </span>
                </button>
              );
            })}
          </aside>
        </div>
      )}
    </section>
  );
}
