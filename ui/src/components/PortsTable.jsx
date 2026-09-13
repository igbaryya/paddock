/**
 * The listening-port table. Rendering only — the page above owns filtering, refreshing and the
 * summary, so this stays usable anywhere a list of ports needs showing.
 *
 * Its job is to be honest about how much it knows. A port this manager started is offered its own
 * lifecycle controls, because stopping it any other way would corrupt the manager's state. Anything
 * else gets a plain Stop behind a confirmation naming the pid. A port whose owner matched two
 * configured processes equally well, or whose owner the OS would not name, is shown as exactly that
 * and offered nothing — a guess here sends someone to kill the wrong process.
 */
import { useState } from 'react';
import Icon from './Icon.jsx';

/** Medium and low come from a directory or a command-line substring — a hint, and labelled as one. */
const isTrusted = (owner) => owner.confidence === 'exact' || owner.confidence === 'high';

function OwnerCell({ owner }) {
  if (owner.kind === 'managed') {
    return (
      <>
        <span className="port-app">{owner.applicationName}</span>
        <span className="port-sep">/</span>
        <span className="port-proc">{owner.processName}</span>
        {!isTrusted(owner) && <span className="tag" title="Matched by directory or command line, not by process identity">likely</span>}
      </>
    );
  }
  if (owner.kind === 'ambiguous') {
    return (
      <span className="port-unknown" title={owner.candidates.map((c) => `${c.applicationName}/${c.processName}`).join(', ')}>
        several processes match
      </span>
    );
  }
  if (owner.kind === 'unknown') {
    return <span className="port-unknown" title="The operating system reported the socket but not its owner">owner not visible</span>;
  }
  // "Not managed" and "owner not visible" are different answers: one means we looked and this is
  // someone else's process, the other means the OS would not say. Collapsing them would claim
  // knowledge we do not have.
  return <span className="port-unknown">not managed</span>;
}

/**
 * @param {{usage: object, busy: boolean, onStopManaged: Function, onRestartManaged: Function,
 *          onStopUnmanaged: Function, onSelect: Function, expanded: boolean}} props
 */
function PortRow({ usage, busy, onStopManaged, onRestartManaged, onStopUnmanaged, onSelect, expanded }) {
  const { owner } = usage;
  const managed = owner.kind === 'managed' && isTrusted(owner);
  const stoppable = Number.isInteger(usage.pid) && owner.kind !== 'ambiguous';

  return (
    <>
      <tr className={expanded ? 'port-row expanded' : 'port-row'}>
        <td>
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded}
            onClick={onSelect}
            title="Show everything known about this port"
          >
            <Icon name="chevron" size={12} className={expanded ? 'rotated' : ''} />
            {usage.port}
          </button>
        </td>
        <td className="mono">{usage.pid ?? '—'}</td>
        <td className="mono ellipsis" title={usage.commandLine ?? usage.processName ?? ''}>
          {usage.processName ?? '—'}
        </td>
        <td className="port-owner"><OwnerCell owner={owner} /></td>
        <td>
          <span className={`tag ${usage.exposed ? 'warn' : ''}`} title={usage.addresses.join(', ')}>
            {usage.exposed ? 'exposed' : 'local'}
          </span>
        </td>
        <td className="port-actions">
          <div className="port-actions-inner">
          {managed ? (
            <>
              <button type="button" className="btn small" disabled={busy} onClick={onRestartManaged}>
                <Icon name="restart" />
                Restart
              </button>
              <button type="button" className="btn small" disabled={busy} onClick={onStopManaged}>
                <Icon name="stop" />
                Stop
              </button>
            </>
          ) : (
            // No Restart for anything unmanaged: nothing here knows how it was started, and a
            // fabricated command would be worse than no button.
            <button
              type="button"
              className="btn small"
              disabled={busy || !stoppable}
              title={owner.kind === 'ambiguous' ? 'Owner is ambiguous — resolve it in the application first' : undefined}
              onClick={onStopUnmanaged}
            >
              <Icon name="stop" />
              Stop
            </button>
          )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="port-detail-row">
          <td colSpan={6}>
            <dl className="port-detail">
              <dt>Addresses</dt>
              <dd className="mono">{usage.addresses.join(', ')}</dd>
              <dt>Executable</dt>
              <dd className="mono">{usage.executablePath ?? <span className="port-unknown">not readable</span>}</dd>
              <dt>Command</dt>
              <dd className="mono wrap">{usage.commandLine ?? <span className="port-unknown">not readable</span>}</dd>
              <dt>Working directory</dt>
              <dd className="mono wrap">{usage.workingDirectory ?? <span className="port-unknown">not readable</span>}</dd>
              <dt>Started</dt>
              <dd className="mono">{usage.startedAt ?? <span className="port-unknown">unknown</span>}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * @param {{ports: object[]|null, isBusy: (port: number) => boolean, onStopPort: Function,
 *          onProcessAction: Function}} props
 */
export default function PortsTable({ ports, isBusy, onStopPort, onProcessAction }) {
  const [expanded, setExpanded] = useState(null);

  const confirmStop = (usage) => {
    const what = usage.commandLine ?? usage.processName ?? 'this process';
    // An unmanaged process belongs to someone else on this machine; naming the pid and the command
    // is the difference between a deliberate act and an accident.
    if (window.confirm(`Stop pid ${usage.pid} listening on port ${usage.port}?\n\n${what}`)) {
      onStopPort(usage.port);
    }
  };

  if (ports === null) return <p className="empty-inline">Scanning…</p>;
  if (ports.length === 0) return <p className="empty-inline">No ports match.</p>;

  return (
    <div className="table-scroll">
      <table className="ports-table">
        <thead>
          <tr>
            <th scope="col">Port</th>
            <th scope="col">PID</th>
            <th scope="col">Process</th>
            <th scope="col">Application</th>
            <th scope="col">Reach</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {ports.map((usage) => {
            const key = `${usage.port}:${usage.pid ?? 'unknown'}`;
            return (
              <PortRow
                key={key}
                usage={usage}
                expanded={expanded === key}
                busy={isBusy(usage.port)}
                onSelect={() => setExpanded(expanded === key ? null : key)}
                onStopManaged={() => onProcessAction(usage.owner.applicationId, usage.owner.processId, 'stop')}
                onRestartManaged={() => onProcessAction(usage.owner.applicationId, usage.owner.processId, 'restart')}
                onStopUnmanaged={() => confirmStop(usage)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
