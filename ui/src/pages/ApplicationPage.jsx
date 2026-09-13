/**
 * One application in full: its controls, every process, and the log tail.
 *
 * `application` is null both before the first fetch and when the id in the URL does not exist, and
 * those are different situations — a link someone saved after deleting the application should say
 * so rather than spinning forever.
 */
import ApplicationPane from '../components/ApplicationPane.jsx';
import LogViewer from '../components/LogViewer.jsx';
import { Link, paths } from '../router.jsx';

/**
 * @param {{application: object|null, loaded: boolean, logs: object[], busy: Set<string>,
 *          staleProcesses: string[], onClearLogs: () => void, onAction: Function,
 *          onEdit: Function, onDelete: Function, onAddProcess: Function,
 *          onProcessAction: Function, onEditProcess: Function, onDeleteProcess: Function}} props
 */
export default function ApplicationPage({
  application,
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
}) {
  if (!application) {
    return loaded ? (
      <div className="empty">
        <h2>No such application</h2>
        <p>It may have been deleted, or the link may be out of date.</p>
        <Link to={paths.overview()} className="btn primary">
          Back to applications
        </Link>
      </div>
    ) : (
      <p className="empty-inline">Loading…</p>
    );
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={paths.overview()}>Applications</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{application.name}</span>
      </nav>

      <ApplicationPane
        application={application}
        busy={busy}
        staleProcesses={staleProcesses}
        onAction={onAction}
        onEdit={onEdit}
        onDelete={onDelete}
        onAddProcess={onAddProcess}
        onProcessAction={onProcessAction}
        onEditProcess={onEditProcess}
        onDeleteProcess={onDeleteProcess}
      />

      {/* Keyed by application: the log tab and stream filter belong to the application being looked
          at, and carrying a process id across a switch would filter out everything. */}
      <LogViewer
        key={application.id}
        application={application}
        logs={logs}
        onClear={onClearLogs}
      />
    </>
  );
}
