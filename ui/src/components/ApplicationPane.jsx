/**
 * The selected application: what it is, whether it is up, and one row per configured process.
 * Application-level controls act on every enabled process in configured order, which is why they
 * are kept visually separate from the per-process controls underneath.
 *
 * A PostgreSQL application shows where its server is reached instead of offering to add processes:
 * its one process comes from its settings, so it is edited through Edit, not on the row.
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
 * Where the database tools connect, as a URL a developer can paste into psql, and where the server's
 * files are. The password is never in the view, so it is never in the URL either.
 * @param {{settings: object}} props the application's `postgres` view
 */
function PostgresFacts({ settings }) {
  const url = `postgresql://${settings.user}@${settings.host}:${settings.port}/${settings.maintenanceDatabase}`;
  return (
    <>
      <dl className="process-facts">
        <dt>url</dt>
        <dd><code>{url}</code>{settings.passwordSet && <span className="meta"> password saved</span>}</dd>
        <dt>data</dt>
        <dd><code>{settings.dataDirectory}</code></dd>
        <dt>bin</dt>
        <dd><code>{settings.binDirectory ?? 'pg_ctl on PATH'}</code></dd>
        <dt>log</dt>
        <dd><code>{settings.logFile ?? "Paddock's own"}</code></dd>
      </dl>
      <p className="hint">
        Run with pg_ctl, outside Paddock: it keeps running when Paddock stops, and a server started
        from a terminal shows here as running.
      </p>
    </>
  );
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
  const postgres = application.kind === 'postgres';

  return (
    <section className="pane" aria-label={`Application ${application.name}`}>
      <header className="pane-head">
        <div className="pane-title">
          <StatusDot status={application.status} showLabel />
          <h2>{application.name}</h2>
          {postgres && <span className="tag">PostgreSQL</span>}
          <span className="counts">
            {counts.running}/{counts.enabled} running &middot; {counts.total} configured
            {counts.crashed > 0 && ` · ${counts.crashed} crashed`}
            {counts.failed > 0 && ` · ${counts.failed} failed`}
          </span>
        </div>
        {application.description && <p className="muted">{application.description}</p>}
        {postgres && <PostgresFacts settings={application.postgres} />}
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
          {!postgres && (
            <button type="button" className="btn ghost" onClick={onAddProcess}>
              <Icon name="plus" />
              Add process
            </button>
          )}
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
              pathLabel={postgres ? 'data' : 'repo'}
              onAction={(action) => onProcessAction(process.id, action)}
              onEdit={postgres ? null : () => onEditProcess(process)}
              onDelete={postgres ? null : () => onDeleteProcess(process)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
