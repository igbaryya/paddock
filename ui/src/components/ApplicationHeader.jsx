/**
 * The application page's top bar: a back button, the application's icon and name, whether it is up,
 * and the controls that act on every process at once.
 *
 * Only what applies to the whole application is up here. Editing one process or deleting anything
 * belongs to a single card and lives in that card's drawer — which also puts the application's own
 * Delete a deliberate click away from its Stop, rather than beside it. The log of every process at
 * once is the one exception: it is the whole application's output, so it is a control on this bar.
 * A terminal is the same case — it opens in one of the application's repositories, and which one
 * is chosen from the dropdown beside the lifecycle controls, not from a single card.
 */
import StatusDot from './StatusDot.jsx';
import IconButton from './IconButton.jsx';
import AppIcon from './AppIcon.jsx';
import TerminalButton from './TerminalButton.jsx';
import Toolbar from './Toolbar.jsx';
import { paths } from '../router.jsx';

/** @param {{application: object}} props */
function Summary({ application }) {
  const counts = application.processCounts;
  return (
    <>
      <StatusDot status={application.status} showLabel />
      {application.kind === 'postgres' && <span className="tag">PostgreSQL</span>}
      <span className="counts">
        {counts.running}/{counts.enabled} running &middot; {counts.total} configured
        {counts.crashed > 0 && ` · ${counts.crashed} crashed`}
        {counts.failed > 0 && ` · ${counts.failed} failed`}
      </span>
    </>
  );
}

/**
 * @param {{application: object, favicons: Record<string, object>, busy: boolean,
 *          onAction: (action: string) => void, onEdit: () => void,
 *          onAddProcess: () => void, onOpenLogs: () => void,
 *          onTerminalChoose: (choice: {kind: 'session', sessionId: string} |
 *                                     {kind: 'new', processId: string}) => void}} props
 */
export default function ApplicationHeader({
  application,
  favicons,
  busy,
  onAction,
  onEdit,
  onAddProcess,
  onOpenLogs,
  onTerminalChoose,
}) {
  // A PostgreSQL application's one process comes from its settings, so there is nothing to add.
  const postgres = application.kind === 'postgres';
  // The accent means "there is something to start": not once everything is up, and not while there
  // is nothing configured to start — a PostgreSQL application before its server is defined.
  const startable = application.status !== 'running' && application.processes.length > 0;

  return (
    <Toolbar
      back={{ to: paths.overview(), label: 'All applications' }}
      leading={<AppIcon application={application} favicons={favicons} size="md" />}
      title={application.name}
      subtitle={<Summary application={application} />}
    >
      <span className="button-group" role="group" aria-label="Every process">
        <IconButton
          icon="play"
          label="Start all"
          className={startable ? 'accent' : ''}
          disabled={busy}
          onClick={() => onAction('start')}
        />
        <IconButton icon="stop" label="Stop all" disabled={busy} onClick={() => onAction('stop')} />
        <IconButton icon="restart" label="Restart all" disabled={busy} onClick={() => onAction('restart')} />
      </span>
      {/* Beside the lifecycle controls: pick which shell to show or where to open a new one. */}
      <TerminalButton applicationId={application.id} onChoose={onTerminalChoose} />
      <IconButton icon="logs" label="Open logs" onClick={onOpenLogs} />
      <span className="button-group" role="group" aria-label="Configuration">
        {!postgres && <IconButton icon="plus" label="Add process" onClick={onAddProcess} />}
        <IconButton icon="pencil" label="Edit application" onClick={onEdit} />
      </span>
    </Toolbar>
  );
}
