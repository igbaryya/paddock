/**
 * One application on the overview grid. It has to answer, without being opened: is this up, how
 * much of it is up, what is in it, and which ports it took.
 *
 * The whole card is a link, and the lifecycle buttons sit inside it — so their clicks are stopped
 * from bubbling into the navigation. Starting an application from the overview is the common case;
 * being taken to its page because you aimed at Start is not.
 */
import StatusDot from './StatusDot.jsx';
import Icon from './Icon.jsx';
import { Link, paths } from '../router.jsx';

/** Enough to recognise the application; past this the card would just be its detail page. */
const PREVIEW_LIMIT = 4;

/**
 * The icons of the application's processes, one per distinct image: a web app and its admin panel
 * that ship the same favicon are one icon beside the name, not two identical ones.
 * @returns {{dataUrl: string, names: string[]}[]}
 */
function iconsOf(application, favicons) {
  const byImage = new Map();
  for (const process of application.processes) {
    const dataUrl = favicons[process.id]?.dataUrl;
    if (!dataUrl) continue;
    if (!byImage.has(dataUrl)) byImage.set(dataUrl, { dataUrl, names: [] });
    byImage.get(dataUrl).names.push(process.name);
  }
  return [...byImage.values()];
}

/**
 * @param {{application: object, favicons: Record<string, {dataUrl: string}>, busy: boolean,
 *          onAction: (action: string) => void}} props
 */
export default function ApplicationCard({ application, favicons, busy, onAction }) {
  const counts = application.processCounts;
  const preview = application.processes.slice(0, PREVIEW_LIMIT);
  const overflow = application.processes.length - preview.length;
  const ports = application.processes.flatMap((p) => p.ports ?? []).sort((a, b) => a - b);
  const icons = iconsOf(application, favicons);

  const act = (event, action) => {
    event.preventDefault();
    event.stopPropagation();
    onAction(action);
  };

  return (
    <Link to={paths.application(application.id)} className="card" aria-label={application.name}>
      <header className="card-head">
        <StatusDot status={application.status} showLabel />
        {application.kind === 'postgres' ? (
          <span className="tag">PostgreSQL</span>
        ) : (
          <span className="card-counts">
            {counts.running}/{counts.enabled} running
          </span>
        )}
      </header>

      <h3 className="card-title">
        {icons.length > 0 && (
          <span className="card-icons">
            {icons.map((icon) => (
              // Decorative: the name beside it already says what the application is, so the alt is
              // empty and the process names ride on the tooltip instead.
              <img key={icon.dataUrl} src={icon.dataUrl} alt="" title={icon.names.join(', ')} />
            ))}
          </span>
        )}
        {application.name}
      </h3>
      {application.description ? (
        <p className="card-desc">{application.description}</p>
      ) : (
        <p className="card-desc empty-text">No description</p>
      )}

      {application.processes.length === 0 ? (
        <p className="card-processes empty-text">No processes configured yet</p>
      ) : (
        <ul className="card-processes">
          {preview.map((process) => (
            <li key={process.id}>
              <StatusDot status={process.status} />
              <span className="card-proc-name">{process.name}</span>
              {process.ports?.length > 0 && (
                <span className="card-proc-port">:{process.ports[0]}</span>
              )}
            </li>
          ))}
          {overflow > 0 && <li className="empty-text">+{overflow} more</li>}
        </ul>
      )}

      <footer className="card-foot">
        <div className="card-actions">
          <button
            type="button"
            className="btn small"
            disabled={busy}
            aria-label={`Start ${application.name}`}
            onClick={(event) => act(event, 'start')}
          >
            <Icon name="play" />
            Start
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            aria-label={`Stop ${application.name}`}
            onClick={(event) => act(event, 'stop')}
          >
            <Icon name="stop" />
            Stop
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            aria-label={`Restart ${application.name}`}
            onClick={(event) => act(event, 'restart')}
          >
            <Icon name="restart" />
            Restart
          </button>
        </div>
        {/* `ports` is null until a scan has run, so an empty list is the honest thing to omit. */}
        {ports.length > 0 && (
          <span className="card-ports" title="Listening on">
            {ports.slice(0, 3).map((port) => (
              <span key={port} className="port-chip">:{port}</span>
            ))}
            {ports.length > 3 && <span className="empty-text">+{ports.length - 3}</span>}
          </span>
        )}
      </footer>
    </Link>
  );
}
