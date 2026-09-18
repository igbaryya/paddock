/**
 * The application's processes, one tile each, in a grid that wraps as the window narrows. The log
 * panel underneath takes whatever height is left, so a short list of processes gives it most of the
 * window and a long one lets the page scroll instead of squeezing either.
 *
 * A PostgreSQL application has one process, derived from its settings — whose Edit opens those
 * settings, and which has no Delete — and a second tile saying where its server is reached. Until its
 * server is defined it has neither, only the box that defines it.
 */
import { useEffect, useState } from 'react';
import ProcessTile from './ProcessTile.jsx';
import Icon from './Icon.jsx';

/** Uptime that never moves reads as a frozen dashboard; one tick for the grid beats one per tile. */
function useSecondsTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Where the database tools connect, as a URL a developer can paste into psql. The password is never
 * in the view, so it is never in the URL either. The data directory is on the server's own tile.
 * @param {{settings: object}} props the application's `postgres` view
 */
function ConnectionTile({ settings }) {
  const url = `postgresql://${settings.user}@${settings.host}:${settings.port}/${settings.maintenanceDatabase}`;
  return (
    <li className="process-tile connection-tile">
      <div className="tile-head">
        <Icon name="database" />
        <span className="process-name">Connection</span>
        <span className="spacer" />
        {settings.passwordSet && <span className="tag">password saved</span>}
      </div>
      <dl className="tile-facts tile-well">
        <dt>url</dt>
        <dd className="tile-value" title={url}><code className="cmd">{url}</code></dd>
        <dt>bin</dt>
        <dd className="tile-value from-end" title={settings.binDirectory ?? undefined}>
          <code dir="ltr">{settings.binDirectory ?? 'pg_ctl on PATH'}</code>
        </dd>
        <dt>log</dt>
        <dd className="tile-value from-end" title={settings.logFile ?? undefined}>
          <code dir="ltr">{settings.logFile ?? "Paddock's own"}</code>
        </dd>
      </dl>
      <p className="hint">
        Run with pg_ctl, outside Paddock: it keeps running when Paddock stops, and a server started
        from a terminal shows here as running.
      </p>
    </li>
  );
}

/**
 * A PostgreSQL application's slot before its server is defined: the whole box is the control, the
 * way the empty process list points at Add process.
 * @param {{onDefine: () => void}} props
 */
function DefinePostgresTile({ onDefine }) {
  return (
    <li className="process-tile define-tile">
      <button type="button" className="define-box" onClick={onDefine}>
        <span className="define-mark">
          <img src="/postgres.svg" alt="" />
        </span>
        <span className="define-title">
          <Icon name="plus" size={14} />
          Define PostgreSQL
        </span>
        <span className="hint">Point this application at a cluster on this machine.</span>
      </button>
    </li>
  );
}

/**
 * @param {{application: object, busy: Set<string>, staleProcesses: string[],
 *          onProcessAction: (processId: string, action: string) => void,
 *          onEditProcess: (process: object) => void,
 *          onDeleteProcess: (process: object) => void,
 *          onEditPostgres: () => void}} props
 */
export default function ProcessGrid({
  application,
  busy,
  staleProcesses,
  onProcessAction,
  onEditProcess,
  onDeleteProcess,
  onEditPostgres,
}) {
  const now = useSecondsTick();
  const postgres = application.kind === 'postgres';
  const settings = application.postgres;

  if (!postgres && application.processes.length === 0) {
    return (
      <p className="empty-inline process-empty">
        No processes yet. Add one with its repository path and the command that starts it.
      </p>
    );
  }

  return (
    <ul className="process-grid" aria-label="Processes">
      {application.processes.map((process) => (
        <ProcessTile
          key={process.id}
          process={process}
          now={now}
          busy={busy.has(process.id)}
          stale={staleProcesses.includes(process.id)}
          pathLabel={postgres ? 'data' : 'repo'}
          onAction={(action) => onProcessAction(process.id, action)}
          onEdit={postgres ? onEditPostgres : () => onEditProcess(process)}
          onDelete={postgres ? null : () => onDeleteProcess(process)}
        />
      ))}
      {settings && <ConnectionTile settings={settings} />}
      {postgres && !settings && <DefinePostgresTile onDefine={onEditPostgres} />}
    </ul>
  );
}
