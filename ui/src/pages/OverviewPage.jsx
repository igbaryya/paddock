/**
 * The landing page: every configured application as a card, plus a one-line read on the machine.
 * This is the screen someone leaves open, so it answers "is anything broken" from across the desk.
 */
import ApplicationCard from '../components/ApplicationCard.jsx';
import Icon from '../components/Icon.jsx';
import { useFavicons } from '../useFavicons.js';

/**
 * @param {{applications: object[], ports: object, busy: Set<string>,
 *          onCreate: () => void, onAction: (id: string, action: string) => void}} props
 */
export default function OverviewPage({ applications, ports, busy, onCreate, onAction }) {
  const running = applications.filter((a) => a.status === 'running').length;
  const degraded = applications.filter((a) => a.status === 'partial' || a.status === 'failed').length;
  const managedPorts = (ports.ports ?? []).filter((p) => p.owner.kind === 'managed').length;
  const favicons = useFavicons(applications);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Applications</h1>
          <p className="page-sub">
            Each one is a group of local repositories, or a PostgreSQL server, started and supervised together.
          </p>
        </div>
        <button type="button" className="btn primary" onClick={onCreate}>
          <Icon name="plus" />
          New application
        </button>
      </header>

      {applications.length > 0 && (
        <div className="stat-row">
          <div className="stat">
            <span className="stat-value">{applications.length}</span>
            <span className="stat-label">configured</span>
          </div>
          <div className="stat">
            <span className="stat-value stat-ok">{running}</span>
            <span className="stat-label">fully running</span>
          </div>
          <div className="stat">
            <span className={`stat-value${degraded ? ' stat-warn' : ''}`}>{degraded}</span>
            <span className="stat-label">needs attention</span>
          </div>
          <div className="stat">
            <span className="stat-value">{ports.ports === null ? '—' : managedPorts}</span>
            <span className="stat-label">ports held</span>
          </div>
        </div>
      )}

      {applications.length === 0 ? (
        <div className="empty">
          <h2>Nothing configured yet</h2>
          <p>
            An application is a group of local repositories and the command that starts each one —
            the thing your <code>run-dev</code> script does today.
          </p>
          <button type="button" className="btn primary" onClick={onCreate}>
            Create the first one
          </button>
        </div>
      ) : (
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
      )}
    </>
  );
}
