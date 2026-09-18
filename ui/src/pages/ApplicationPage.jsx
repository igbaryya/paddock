/**
 * One application in full: its toolbar, its processes as a grid of tiles, and the log tail filling
 * the rest of the window — and for a PostgreSQL application with a server, the SQL console between
 * them.
 *
 * `application` is null both before the first fetch and when the id in the URL does not exist, and
 * those are different situations — a link someone saved after deleting the application should say
 * so rather than spinning forever.
 */
import ApplicationHeader from '../components/ApplicationHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ProcessGrid from '../components/ProcessGrid.jsx';
import LogViewer from '../components/LogViewer.jsx';
import SqlConsole from '../components/SqlConsole.jsx';
import { Link, paths } from '../router.jsx';

/**
 * @param {{application: object|null, favicons: Record<string, object>, loaded: boolean,
 *          logs: object[], busy: Set<string>, staleProcesses: string[], onClearLogs: () => void,
 *          onAction: Function, onEdit: Function, onDelete: Function, onAddProcess: Function,
 *          onProcessAction: Function, onEditProcess: Function, onDeleteProcess: Function,
 *          onEditPostgres: Function}} props
 */
export default function ApplicationPage({
  application,
  favicons,
  loaded,
  logs,
  busy,
  staleProcesses,
  onClearLogs,
  onAction,
  onEdit,
  onDelete,
  onAddProcess,
  onProcessAction,
  onEditProcess,
  onDeleteProcess,
  onEditPostgres,
}) {
  if (!application) {
    return loaded ? (
      <EmptyState
        icon="alert"
        title="No such application"
        action={<Link to={paths.overview()} className="btn primary">Back to applications</Link>}
      >
        It may have been deleted, or the link may be out of date.
      </EmptyState>
    ) : (
      <p className="empty-inline">Loading…</p>
    );
  }

  return (
    <>
      <ApplicationHeader
        application={application}
        favicons={favicons}
        busy={busy.has(application.id)}
        onAction={onAction}
        onEdit={onEdit}
        onDelete={onDelete}
        onAddProcess={onAddProcess}
      />

      <section className="section" aria-label="Processes">
        {/* A PostgreSQL application is one server, so only a group of processes is worth counting. */}
        {application.kind === 'postgres' ? (
          <h2 className="section-title">Server</h2>
        ) : (
          <h2 className="section-title">
            Processes
            <span className="section-count">{application.processes.length}</span>
          </h2>
        )}
        <ProcessGrid
          application={application}
          busy={busy}
          staleProcesses={staleProcesses}
          onProcessAction={onProcessAction}
          onEditProcess={onEditProcess}
          onDeleteProcess={onDeleteProcess}
          onEditPostgres={onEditPostgres}
        />
      </section>

      {/* Keyed by application like the logs below: a query and its result belong to one server. The
          two keys must differ — they are siblings, and siblings sharing a key leave a stale console
          behind on the next application. There is no console before there is a server to query. */}
      {application.postgres && (
        <SqlConsole key={`sql:${application.id}`} application={application} />
      )}

      {/* Keyed by application: the log tab and stream filter belong to the application being looked
          at, and carrying a process id across a switch would filter out everything. */}
      <LogViewer
        key={`logs:${application.id}`}
        application={application}
        logs={logs}
        onClear={onClearLogs}
      />
    </>
  );
}
