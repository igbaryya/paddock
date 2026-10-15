/**
 * Connect an agent: Paddock's entry written into Cursor's or Claude Code's own MCP settings with one
 * click. The manager decides which file and what goes in it; this only names the client. The one it
 * suggests is an installed agent that does not reach Paddock yet — the most recently used, of two.
 */
import { useEffect, useState } from 'react';
import * as api from '../api.js';
import Icon from './Icon.jsx';
import SettingsGroup from './SettingsGroup.jsx';

const ICONS = { cursor: 'monitor', 'claude-code': 'terminal' };

function describe(client) {
  if (client.state === 'configured') return `Added to ${client.displayPath}`;
  if (client.state === 'stale') {
    return `${client.displayPath} points at ${client.configuredUrl ?? 'another address'}, not this Paddock`;
  }
  if (client.state === 'unreadable') return `${client.displayPath} ${client.error} — fix it by hand first`;
  return client.detected
    ? `Adds Paddock to ${client.displayPath}`
    : `Not found on this machine — adding creates ${client.displayPath}`;
}

const WHAT_IT_WRITES =
  'Adds a "paddock" server to the agent\'s user-wide MCP settings and leaves the rest of the file alone.';
const WHEN_IT_CONNECTS =
  'The agent connects the next time it loads its MCP servers: a new Claude Code session, or a Cursor reload.';

/**
 * @param {{client: object, url: string|null, pending: boolean, disabled: boolean,
 *          onInstall: (client: object) => void}} props
 */
function ClientRow({ client, url, pending, disabled, onInstall }) {
  const actionable = client.state === 'missing' || client.state === 'stale';
  return (
    <div className="group-row">
      <span className="row-icon"><Icon name={ICONS[client.id] ?? 'braces'} size={14} /></span>
      <div className="row-text">
        <span className="row-title">
          {client.name}
          {client.suggested && <span className="tag row-tag">Suggested</span>}
        </span>
        <span className={`row-sub${client.state === 'unreadable' ? ' danger' : ''}`}>{describe(client)}</span>
      </div>
      {client.state === 'configured' ? (
        <span className="tag row-tag">
          <Icon name="check" size={11} /> Added
        </span>
      ) : (
        actionable && (
          <button
            type="button"
            className={`btn small${client.suggested ? ' primary' : ''}`}
            disabled={disabled || !url}
            onClick={() => onInstall(client)}
          >
            {pending ? 'Adding…' : client.state === 'stale' ? `Update ${client.name}` : `Add to ${client.name}`}
          </button>
        )
      )}
    </div>
  );
}

/** @param {{url: string|null}} props the MCP URL; a change re-reads which clients still reach it */
export default function McpClients({ url }) {
  const [clients, setClients] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [added, setAdded] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api.listMcpClients(controller.signal).then(
      (view) => {
        setClients(view.clients);
        setError(null);
      },
      (err) => {
        if (!controller.signal.aborted) setError(err.message);
      }
    );
    return () => controller.abort();
  }, [url]);

  const install = async (client) => {
    setPending(client.id);
    setError(null);
    try {
      setClients((await api.installMcpClient(client.id)).clients);
      setAdded(client.name);
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(null);
    }
  };

  const note = !url
    ? 'Install MCP above first — there is no URL to give an agent yet.'
    : added
      ? `Added to ${added}. ${WHEN_IT_CONNECTS}`
      : `${WHAT_IT_WRITES} ${WHEN_IT_CONNECTS}`;

  return (
    <SettingsGroup title="Connect an agent" note={note}>
      {error && (
        <div className="group-row row-warn">
          <Icon name="alert" />
          <span className="row-text row-sub">{error}</span>
        </div>
      )}
      {clients === null
        ? !error && (
            <div className="group-row">
              <span className="row-sub">Looking for agents…</span>
            </div>
          )
        : clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              url={url}
              pending={pending === client.id}
              disabled={pending !== null}
              onInstall={install}
            />
          ))}
    </SettingsGroup>
  );
}
