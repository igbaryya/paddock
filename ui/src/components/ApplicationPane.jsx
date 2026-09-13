/**
 * The selected application: what it is, whether it is up, and one row per configured process.
 * Application-level controls act on every enabled process in configured order, which is why they
 * are kept visually separate from the per-process controls underneath.
 */
import { useEffect, useState } from 'react';
import StatusDot from './StatusDot.jsx';
import ProcessRow from './ProcessRow.jsx';
import Icon from './Icon.jsx';

/** Uptime that never moves reads as a frozen dashboard; one tick for the pane beats one per row. */
function useSecondsTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * @param {{application: object, busy: Set<string>, staleProcesses: string[],
 *          onAction: (action: string) => void, onEdit: () => void, onDelete: () => void,
 *          onAddProcess: () => void, onProcessAction: (processId: string, action: string) => void,
 *          onEditProcess: (process: object) => void,
 *          onDeleteProcess: (process: object) => void}} props
 */
export default function ApplicationPane({
  application,
  busy,
  staleProcesses,
  onAction,
  onEdit,
  onDelete,
  onAddProcess,
  onProcessAction,
  onEditProcess,
  onDeleteProcess,
}) {
  const now = useSecondsTick();
  const counts = application.processCounts;
  const waiting = busy.has(application.id);

  return (
    <section className="pane" aria-label={`Application ${application.name}`}>
      <header className="pane-head">
        <div className="pane-title">
          <StatusDot status={application.status} showLabel />
          <h2>{application.name}</h2>
          <span className="counts">
            {counts.running}/{counts.enabled} running &middot; {counts.total} configured
            {counts.crashed > 0 && ` · ${counts.crashed} crashed`}
            {counts.failed > 0 && ` · ${counts.failed} failed`}
          </span>
        </div>
        {application.description && <p className="muted">{application.description}</p>}
        <div className="actions">
          <button type="button" className="btn primary" disabled={waiting} onClick={() => onAction('start')}>
            <Icon name="play" />
            Start
          </button>
          <button type="button" className="btn" disabled={waiting} onClick={() => onAction('stop')}>
            <Icon name="stop" />
            Stop
          </button>
          <button type="button" className="btn" disabled={waiting} onClick={() => onAction('restart')}>
            <Icon name="restart" />
            Restart
          </button>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onAddProcess}>
            <Icon name="plus" />
            Add process
          </button>
          <button type="button" className="btn ghost" onClick={onEdit}>
            <Icon name="pencil" />
            Edit
          </button>
          <button type="button" className="btn ghost danger" onClick={onDelete}>
            <Icon name="trash" />
            Delete
          </button>
        </div>
      </header>

      {application.processes.length === 0 ? (
        <p className="empty-inline">
          No processes yet. Add one with its repository path and the command that starts it.
        </p>
      ) : (
        <ul className="process-list">
          {application.processes.map((process) => (
            <ProcessRow
              key={process.id}
              process={process}
              now={now}
              busy={busy.has(process.id)}
              stale={staleProcesses.includes(process.id)}
              onAction={(action) => onProcessAction(process.id, action)}
              onEdit={() => onEditProcess(process)}
              onDelete={() => onDeleteProcess(process)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
