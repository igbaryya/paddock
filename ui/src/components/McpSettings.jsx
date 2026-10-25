/**
 * The MCP tab of Settings: the port agents use, whether the listener is up and why not, which agents
 * are connected and what they called, and a short history of the listener itself.
 */
import { useEffect, useId, useState } from 'react';
import * as api from '../api.js';
import { describeMcpListener } from '../format.js';
import AgentActivity from './AgentActivity.jsx';
import CopyButton from './CopyButton.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import McpClients from './McpClients.jsx';
import SettingsGroup from './SettingsGroup.jsx';
import StatusDot from './StatusDot.jsx';

/** @param {{message: string}} props */
const ErrorNotice = ({ message }) => (
  <p className="notice danger" role="alert">
    <Icon name="alert" />
    <span>{message}</span>
  </p>
);

/** The address to give an agent, copyable. The setup wizard's MCP step shows the same row. */
export const McpUrlRow = ({ url }) => (
  <div className="group-row">
    <span className="row-icon muted"><Icon name="globe" size={14} /></span>
    <div className="row-text">
      <span className="row-title">URL</span>
      <span className="row-sub">Give this to your agent.</span>
    </div>
    <div className="command-well address settings-url">
      <code>{url}</code>
      <CopyButton text={url} label="Copy MCP URL" />
    </div>
  </div>
);

const formatWhen = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
};

/**
 * @param {{busy: boolean, live: {sessions: object[]|null, calls: object[]},
 *          onAction: (action: string, body?: object) => Promise<void>}} props
 */
export default function McpSettings({ busy, live, onAction }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [portDraft, setPortDraft] = useState('');
  const portId = useId();

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

  if (!state) {
    return error ? (
      <>
        <ErrorNotice message={error} />
        <button type="button" className="btn" onClick={load}>
          Retry
        </button>
      </>
    ) : (
      <p className="empty-inline" role="status">
        Loading…
      </p>
    );
  }

  const status = state.configured && state.running ? 'running' : 'stopped';

  return (
    <>
      {/* A refresh that failed after an action: what is shown below may be out of date. */}
      {error && <ErrorNotice message={`Could not refresh: ${error}`} />}
      {/* Enabled but not listening is the one state where an agent silently cannot connect. */}
      {state.lastError && !state.running && (
        <ErrorNotice message={`MCP could not start: ${state.lastError.message}`} />
      )}

      <SettingsGroup
        title="Listener"
        note="The dashboard and MCP use different ports. Changing the MCP port restarts the listener."
      >
        <div className="group-row">
          <span className="row-icon"><Icon name="braces" size={14} /></span>
          <div className="row-text">
            <span className="row-title">MCP server</span>
            <span className="row-sub">{describeMcpListener(state)}</span>
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

        {state.url && <McpUrlRow url={state.url} />}

        <div className="group-row">
          <span className="row-icon muted"><Icon name="ports" size={14} /></span>
          <div className="row-text">
            <label className="row-title" htmlFor={portId}>
              Port
            </label>
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
                id={portId}
                className="field-input compact"
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                disabled={busy}
                onChange={(event) => setPortDraft(event.target.value)}
              />
              <button type="submit" className="btn small" disabled={busy || portDraft === String(state.port)}>
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
      </SettingsGroup>

      <McpClients url={state.url} />

      <AgentActivity live={live} />

      <SettingsGroup title="Listener history">
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
      </SettingsGroup>
    </>
  );
}
