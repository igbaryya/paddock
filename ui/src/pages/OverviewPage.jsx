/**
 * Every configured application as a row of a table, each opening to its services, under a one-line
 * read on them. The dashboard summarises; this is where each application is operated.
 */
import ApplicationsTable from '../components/ApplicationsTable.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon from '../components/Icon.jsx';
import NotLoaded from '../components/NotLoaded.jsx';
import Stat from '../components/Stat.jsx';
import Toolbar from '../components/Toolbar.jsx';

/**
 * @param {{applications: object[], loaded: boolean, unreachable: boolean,
 *          favicons: Record<string, object>, ports: object, busy: Set<string>,
 *          onRetry: () => void, onCreate: () => void,
 *          onAction: (id: string, action: string) => void,
 *          onProcessAction: (applicationId: string, processId: string, action: string) => void,
 *          onEdit: (application: object) => void,
 *          onEditProcess: (application: object, process: object) => void}} props
 */
export default function OverviewPage({
  applications,
  loaded,
  unreachable,
  favicons,
  ports,
  busy,
  onRetry,
  onCreate,
  onAction,
  onProcessAction,
  onEdit,
  onEditProcess,
}) {
  const running = applications.filter((a) => a.status === 'running').length;
  const degraded = applications.filter((a) => a.status === 'partial' || a.status === 'failed').length;
  const managedPorts = (ports.ports ?? []).filter((p) => p.owner.kind === 'managed').length;

  return (
    <>
      <Toolbar
        title="Applications"
        subtitle="Each one is a group of local repositories, or a PostgreSQL server, started and supervised together."
      >
        <button type="button" className="btn primary" onClick={onCreate}>
          <Icon name="plus" />
          New application
        </button>
      </Toolbar>

      {!loaded ? (
        <NotLoaded unreachable={unreachable} onRetry={onRetry} />
      ) : applications.length === 0 ? (
        <EmptyState
          icon="grid"
          title="Nothing configured yet"
          action={
            <button type="button" className="btn primary" onClick={onCreate}>
              Create the first one
            </button>
          }
        >
          An application is a group of local repositories and the command that starts each one — the
          thing your <code>run-dev</code> script does today.
        </EmptyState>
      ) : (
        <>
          <div className="stat-row">
            <Stat icon="grid" value={applications.length} label="configured" />
            <Stat icon="activity" value={running} label="fully running" tone="ok" />
            <Stat
              icon="alert"
              value={degraded}
              label="needs attention"
              tone={degraded ? 'warn' : undefined}
            />
            <Stat icon="ports" value={ports.ports === null ? '—' : managedPorts} label="ports held" />
          </div>

          <ApplicationsTable
            applications={applications}
            favicons={favicons}
            isBusy={(id) => busy.has(id)}
            onAction={onAction}
            onProcessAction={onProcessAction}
            onEdit={onEdit}
            onEditProcess={onEditProcess}
          />
        </>
      )}
    </>
  );
}
