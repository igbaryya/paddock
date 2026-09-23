/**
 * The landing page: every configured application as a card, under a one-line read on the machine.
 * This is the screen someone leaves open, so it answers "is anything broken" from across the desk.
 */
import ApplicationCard from '../components/ApplicationCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon from '../components/Icon.jsx';
import Stat from '../components/Stat.jsx';
import Toolbar from '../components/Toolbar.jsx';

/**
 * Before the first list lands there is nothing to count and nothing to offer: an unreachable manager
 * is an outage, and saying "nothing configured" to it would send someone to recreate what they have.
 * @param {{unreachable: boolean, onRetry: () => void}} props
 */
function NotLoaded({ unreachable, onRetry }) {
  if (!unreachable) {
    return (
      <p className="empty-inline" role="status">
        Loading…
      </p>
    );
  }
  return (
    <EmptyState
      icon="alert"
      title="Can't reach Paddock"
      action={
        <button type="button" className="btn primary" onClick={onRetry}>
          Retry
        </button>
      }
    >
      The dashboard is up but the manager behind it is not answering. Your applications are unchanged.
    </EmptyState>
  );
}

/**
 * @param {{applications: object[], loaded: boolean, unreachable: boolean,
 *          favicons: Record<string, object>, ports: object, busy: Set<string>,
 *          onRetry: () => void, onCreate: () => void,
 *          onAction: (id: string, action: string) => void}} props
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

          <div className="card-grid">
            {applications.map((application) => (
              <ApplicationCard
                key={application.id}
                application={application}
                favicons={favicons}
                busy={busy.has(application.id)}
                onAction={(action) => onAction(application.id, action)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
