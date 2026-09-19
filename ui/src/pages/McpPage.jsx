/**
 * MCP installation and runtime: the port agents use, whether the listener is up, and a short audit
 * of what happened to it.
 */
import { useEffect, useState } from 'react';
import * as api from '../api.js';
import CopyButton from '../components/CopyButton.jsx';
import Icon from '../components/Icon.jsx';
import IconButton from '../components/IconButton.jsx';
import StatusDot from '../components/StatusDot.jsx';
import Toolbar from '../components/Toolbar.jsx';

/** @param {{title: string, note?: string, children: import('react').ReactNode}} props */
function Section({ title, note, children }) {
  return (
    <section className="settings-section">
      <h2 className="group-title">{title}</h2>
      <div className="group">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  );
}

const formatWhen = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
};

/**
 * @param {{busy: boolean, onAction: (action: string, body?: object) => Promise<void>}} props
 */
export default function McpPage({ busy, onAction }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [portDraft, setPortDraft] = useState('');

  const load = () =>
    api.getMcp().then(
      (view) => {
        setState(view);
        setPortDraft(String(view.port ?? ''));
        setError(null);
      },
      (err) => setError(err.message)
    );

  useEffect(() => {
    load();
  }, []);

  const act = async (action, body) => {
    await onAction(action, body);
    await load();
  };

  if (error && !state) {
    return (
      <p className="notice danger" role="alert">
        <Icon name="alert" />
        <span>{error}</span>
      </p>
    );
  }
  if (!state) return <p className="empty-inline">Loading…</p>;

  const status = !state.configured
    ? 'stopped'
    : state.running
      ? 'running'
      : 'stopped';

  return (
    <>
      <Toolbar title="MCP" subtitle="Agents connect here." />

      <Section
        title="Status"
        note="The dashboard and MCP use different ports. Changing the MCP port requires a restart of the listener."
      >
        <div className="group-row">
          <span className="row-icon"><Icon name="braces" size={14} /></span>
          <div className="row-text">
            <span className="row-title">Listener</span>
            <span className="row-sub">
              {state.running
                ? `Running on port ${state.boundPort ?? state.port}`
                : state.configured
                  ? 'Stopped'
                  : 'Not installed yet'}
            </span>
          </div>
          <StatusDot status={status} showLabel />
          <span className="button-group small" role="group" aria-label="MCP lifecycle">
            <IconButton
              icon="play"
              label="Start MCP"
              className={status === 'stopped' && state.configured ? 'accent' : ''}
              disabled={busy || !state.configured || state.running}
              onClick={() => act('start')}
            />
            <IconButton
              icon="stop"
              label="Stop MCP"
              disabled={busy || !state.running}
              onClick={() => act('stop')}
            />
            <IconButton
              icon="restart"
              label="Restart MCP"
              disabled={busy || !state.configured}
              onClick={() => act('restart')}
            />
          </span>
        </div>

        {state.url && (
          <div className="group-row">
            <div className="row-text">
              <span className="row-title">URL</span>
              <div className="command-well">
                <code>{state.url}</code>
                <CopyButton text={state.url} label="Copy MCP URL" />
              </div>
            </div>
          </div>
        )}

        <div className="group-row">
          <div className="row-text">
            <span className="row-title">Port</span>
            <span className="row-sub">
              {state.portLocked
                ? `Locked by PADDOCK_MCP_PORT (${state.port})`
                : 'Stored in your Paddock data directory'}
            </span>
          </div>
          {!state.portLocked && (
            <form
              className="mcp-port-form"
              onSubmit={(event) => {
                event.preventDefault();
                act('update', { port: Number(portDraft) });
              }}
            >
              <input
                className="field-input compact"
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                disabled={busy}
                onChange={(event) => setPortDraft(event.target.value)}
              />
              <button type="submit" className="btn small" disabled={busy}>
                Save
              </button>
            </form>
          )}
        </div>

        {(state.lastStartedAt || state.lastStoppedAt) && (
          <dl className="group-facts">
            {state.lastStartedAt && (
              <div className="fact">
                <dt>Last started</dt>
                <dd>{formatWhen(state.lastStartedAt)}</dd>
              </div>
            )}
            {state.lastStoppedAt && (
              <div className="fact">
                <dt>Last stopped</dt>
                <dd>{formatWhen(state.lastStoppedAt)}</dd>
              </div>
            )}
          </dl>
        )}
      </Section>

      <Section title="Audit">
        {state.audit.length === 0 ? (
          <p className="empty-inline">Nothing recorded yet.</p>
        ) : (
          <ul className="audit-list">
            {state.audit.map((entry) => (
              <li key={`${entry.at}-${entry.action}`} className="audit-row">
                <span className="audit-at">{formatWhen(entry.at)}</span>
                <span className="audit-action">{entry.action}</span>
                {entry.detail && <span className="audit-detail">{entry.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
