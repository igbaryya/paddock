/**
 * One application on the overview grid, drawn as a widget. It has to answer, without being opened:
 * is this up, how much of it is up, what is in it, and which ports it took.
 *
 * The whole card is a link, and the lifecycle buttons sit inside it — so their clicks are stopped
 * from bubbling into the navigation. Starting an application from the overview is the common case;
 * being taken to its page because you aimed at Start is not.
 */
import StatusDot from './StatusDot.jsx';
import AppIcon from './AppIcon.jsx';
import IconButton from './IconButton.jsx';
import { Link, paths } from '../router.jsx';

/** Enough to recognise the application; past this the card would just be its detail page. */
const PREVIEW_LIMIT = 4;

/** A process holding more ports than this shows the rest as a count. */
const PORTS_PER_PROCESS = 2;

const ACTIONS = [
  ['start', 'play', 'Start'],
  ['stop', 'stop', 'Stop'],
  ['restart', 'restart', 'Restart'],
];

/**
 * `ports` is null until a scan has run, so a process without them shows nothing rather than a claim
 * that it holds none.
 * @param {{ports: number[]|null}} props
 */
function ProcessPorts({ ports }) {
  if (!ports?.length) return null;
  const extra = ports.length - PORTS_PER_PROCESS;
  return (
    <span className="card-proc-ports">
      {ports.slice(0, PORTS_PER_PROCESS).map((port) => (
        <span key={port} className="port-chip">:{port}</span>
      ))}
      {extra > 0 && <span title={ports.slice(PORTS_PER_PROCESS).map((p) => `:${p}`).join(' ')}>+{extra}</span>}
    </span>
  );
}

/** @param {{application: object}} props */
function ProcessPreview({ application }) {
  if (application.processes.length === 0) {
    return (
      <p className="card-processes">
        {application.kind === 'postgres' ? 'PostgreSQL not defined yet' : 'No processes configured yet'}
      </p>
    );
  }
  const preview = application.processes.slice(0, PREVIEW_LIMIT);
  const overflow = application.processes.length - preview.length;
  return (
    <ul className="card-processes">
      {preview.map((process) => (
        <li key={process.id}>
          <StatusDot status={process.status} />
          <span className="card-proc-name">{process.name}</span>
          <ProcessPorts ports={process.ports} />
        </li>
      ))}
      {overflow > 0 && <li className="empty-text">+{overflow} more</li>}
    </ul>
  );
}

/**
 * @param {{application: object, favicons: Record<string, {dataUrl: string}>, busy: boolean,
 *          onAction: (action: string) => void}} props
 */
export default function ApplicationCard({ application, favicons, busy, onAction }) {
  const counts = application.processCounts;

  const act = (event, action) => {
    event.preventDefault();
    event.stopPropagation();
    onAction(action);
  };

  return (
    <Link to={paths.application(application.id)} className="card" aria-label={application.name}>
      <header className="card-head">
        <AppIcon application={application} favicons={favicons} />
        <div className="card-heading">
          <h3 className="card-title">{application.name}</h3>
          <p className="card-desc">
            {application.description || <span className="empty-text">No description</span>}
          </p>
        </div>
        <StatusDot status={application.status} showLabel />
      </header>

      <ProcessPreview application={application} />

      <footer className="card-foot">
        <span className="card-counts">
          {application.kind === 'postgres' ? (
            <span className="tag">PostgreSQL</span>
          ) : (
            `${counts.running}/${counts.enabled} running`
          )}
        </span>
        <span className="button-group small" role="group" aria-label={`${application.name} controls`}>
          {ACTIONS.map(([action, icon, verb]) => (
            <IconButton
              key={action}
              icon={icon}
              label={`${verb} ${application.name}`}
              className="small"
              disabled={busy}
              onClick={(event) => act(event, action)}
            />
          ))}
        </span>
      </footer>
    </Link>
  );
}
