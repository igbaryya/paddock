/**
 * The terminals of one application: a tab per open shell, and the control that opens another.
 *
 * Every terminal stays mounted, and only the chosen one is shown. That is the whole reason this
 * component exists rather than rendering one `Terminal` at a time: unmounting a tab would dispose
 * its screen, and coming back to a terminal to find the output of the command you left running
 * replaced by a fresh prompt is the one thing a tabbed terminal must never do.
 *
 * The sessions themselves belong to the manager and outlive this panel, so opening it lists what is
 * already running rather than starting anything. Closing the panel leaves every shell alone.
 */
import { useEffect, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import Segmented from './Segmented.jsx';
import Terminal from './Terminal.jsx';
import TerminalTargetPicker from './TerminalTargetPicker.jsx';
import { closeTerminal, listTerminals, openTerminal } from '../api.js';

/** @param {{application: object}} props */
export default function TerminalPanel({ application }) {
  const [support, setSupport] = useState(null);
  const [targets, setTargets] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listTerminals(application.id, controller.signal).then(
      (state) => {
        setSupport(state.support);
        setTargets(state.targets);
        setSessions(state.sessions);
        // The last one opened is the one being come back to, the same as reopening a terminal app.
        setChosen(state.sessions.at(-1)?.id ?? null);
      },
      (err) => {
        if (err.name !== 'AbortError') setError(err.message);
      }
    );
    return () => controller.abort();
  }, [application.id]);

  /** A tab can be closed, or reaped, out from under the choice; the choice is not corrected for
      that, it is simply resolved against what is still open — the same way the log viewer's source
      tab falls back when the process it named is deleted. */
  const forget = (sessionId) =>
    setSessions((open) => open.filter((session) => session.id !== sessionId));

  const markExited = (sessionId) =>
    setSessions((open) =>
      open.map((session) => (session.id === sessionId ? { ...session, running: false } : session))
    );

  const open = async (processId) => {
    setPicking(false);
    setBusy(true);
    setError(null);
    try {
      const session = await openTerminal(application.id, { processId });
      setSessions((current) => [...current, session]);
      setChosen(session.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /** One place to stand is not a choice; more than one is the question VS Code asks. */
  const requestTerminal = () => {
    setError(null);
    if (targets.length === 1) return open(targets[0].processId);
    setPicking(true);
  };

  const close = async (sessionId) => {
    // Dropped from the list first: the shell is going whatever the request says, and leaving a tab
    // on screen until a round trip finishes makes the click feel like it missed.
    forget(sessionId);
    await closeTerminal(sessionId).catch(() => {
      // Already gone — reaped for being idle, or closed from another dashboard.
    });
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

  // Resolved, never stored: closing the tab that was chosen lands on whatever is still open.
  const active = sessions.find((session) => session.id === chosen) ?? sessions.at(-1) ?? null;

  return (
    <section className="panel terminals" aria-label="Terminals">
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name="terminal" />
          Terminal
        </h2>
        {sessions.length > 0 && (
          <Segmented
            className="terminal-tabs"
            role="tablist"
            label="Open terminals"
            value={active?.id ?? ''}
            onChange={setChosen}
            options={sessions.map((session) => ({
              id: session.id,
              label: (
                <span className={session.running === false ? 'tab-ended' : undefined}>
                  {session.processName ?? 'Shell'}
                </span>
              ),
            }))}
          />
        )}
        <span className="spacer" />
        {active && (
          <span className="meta terminal-cwd" title={active.cwd}>
            {active.cwd}
          </span>
        )}
        <IconButton icon="plus" label="New terminal" disabled={busy} onClick={requestTerminal} />
        {active && (
          <IconButton icon="trash" label="Close terminal" onClick={() => close(active.id)} />
        )}
      </div>

      {error && (
        <p className="notice danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      {sessions.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="No terminal open"
          action={
            <button type="button" className="btn primary" disabled={busy} onClick={requestTerminal}>
              <Icon name="plus" />
              New terminal
            </button>
          }
        >
          A shell in one of this application&rsquo;s repositories, which keeps running while you
          work elsewhere in the dashboard.
        </EmptyState>
      ) : (
        <div className="terminal-stack">
          {sessions.map((session) => (
            // `hidden` rather than unmounting: see the note at the top of this file.
            <div
              key={session.id}
              className="terminal-pane"
              role="tabpanel"
              hidden={session.id !== active?.id}
            >
              <Terminal
                sessionId={session.id}
                active={session.id === active?.id}
                onExit={() => markExited(session.id)}
                onGone={() => forget(session.id)}
              />
            </div>
          ))}
        </div>
      )}

      {picking && (
        <TerminalTargetPicker
          targets={targets}
          onPick={open}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}
