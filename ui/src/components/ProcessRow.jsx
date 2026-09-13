/**
 * One process: its state, where it runs from, what it runs, and the controls that act on it. The
 * repository path and command are shown in full rather than truncated — "which checkout is this
 * serving" is the question this screen exists to answer.
 */
import StatusDot from './StatusDot.jsx';
import Icon from './Icon.jsx';

/** A process being brought up is already burning wall-clock time, so it counts as up. */
const ALIVE = new Set(['starting', 'running', 'stopping']);

const formatUptime = (ms) => {
  // `null` before the first start, and NaN if `startedAt` is ever unparseable — neither is a number
  // of seconds, and printing "NaNs" in a status column is worse than printing nothing.
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1_000);
  const [d, h, m, s] = [Math.floor(total / 86_400), Math.floor(total / 3_600) % 24,
    Math.floor(total / 60) % 60, total % 60];
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
};

/** While the process is alive its uptime is derived from the clock, so it keeps counting. */
const uptimeOf = (process, now) =>
  ALIVE.has(process.status) && process.startedAt
    ? now - Date.parse(process.startedAt)
    : process.uptimeMs;

const exitSummary = (process) => {
  if (process.exitSignal) return `exit on ${process.exitSignal}`;
  if (process.exitCode != null) return `exit ${process.exitCode}`;
  return null;
};

/**
 * @param {{process: object, now: number, busy: boolean, stale: boolean,
 *          onAction: (action: string) => void, onEdit: () => void, onDelete: () => void}} props
 */
export default function ProcessRow({ process, now, busy, stale, onAction, onEdit, onDelete }) {
  const envCount = Object.keys(process.env ?? {}).length;
  const exit = exitSummary(process);
  // A process cannot be started twice, but it must always be stoppable: the manager keeps the
  // process group around after a crash, and that group can still be holding a port.
  const startable = !busy && process.status !== 'running' && process.status !== 'starting';

  return (
    <li className={`process${process.enabled ? '' : ' disabled'}`}>
      <div className="process-head">
        <StatusDot status={process.status} showLabel />
        <span className="process-name">{process.name}</span>
        {!process.enabled && <span className="tag">disabled</span>}
        <span className="meta">pid {process.pid ?? '—'}</span>
        <span className="meta">
          {ALIVE.has(process.status) ? 'up' : 'ran'} {formatUptime(uptimeOf(process, now))}
        </span>
        {process.restarts > 0 && <span className="meta">{process.restarts} restarts</span>}
        {envCount > 0 && <span className="meta">{envCount} env</span>}
        {exit && <span className="meta">{exit}</span>}
      </div>

      <dl className="process-facts">
        <dt>repo</dt>
        <dd><code>{process.repositoryPath}</code></dd>
        <dt>run</dt>
        <dd><code className="cmd">{process.command}</code></dd>
        {process.workingDirectory !== process.repositoryPath && (
          <>
            <dt>cwd</dt>
            <dd><code>{process.workingDirectory}</code></dd>
          </>
        )}
        {/* `null` means no port scan has run yet, which is not the same as listening on nothing —
            so the row is omitted entirely rather than showing an empty list. */}
        {process.ports?.length > 0 && (
          <>
            <dt>ports</dt>
            <dd>
              <span className="port-chips">
                {process.ports.map((port) => (
                  <span key={port} className="port-chip">:{port}</span>
                ))}
              </span>
            </dd>
          </>
        )}
      </dl>

      {process.lastError && <p className="process-error">{process.lastError}</p>}

      {stale && (
        <p className="process-notice">
          <span>Configuration changed while this process was running; it is still on the old one.</span>
          <button type="button" className="btn small" onClick={() => onAction('restart')}>
            <Icon name="restart" />
            Restart to apply
          </button>
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn small"
          disabled={!startable}
          aria-label={`Start ${process.name}`}
          onClick={() => onAction('start')}
        >
          <Icon name="play" />
          Start
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy}
          aria-label={`Stop ${process.name}`}
          onClick={() => onAction('stop')}
        >
          <Icon name="stop" />
          Stop
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy}
          aria-label={`Restart ${process.name}`}
          onClick={() => onAction('restart')}
        >
          <Icon name="restart" />
          Restart
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn small ghost"
          aria-label={`Edit ${process.name}`}
          onClick={onEdit}
        >
          <Icon name="pencil" />
          Edit
        </button>
        <button
          type="button"
          className="btn small ghost danger"
          aria-label={`Delete ${process.name}`}
          onClick={onDelete}
        >
          <Icon name="trash" />
          Delete
        </button>
      </div>
    </li>
  );
}
