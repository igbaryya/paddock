/**
 * The cards that sit on an application's canvas.
 *
 * Every one of them is the same object on screen — a header strip with an icon, a name and a state,
 * and a body under it — so they share `NodeShell` and differ only in what they put in the body. The
 * header is where the curves between cards meet, which is why its height is fixed and why nothing
 * in it is allowed to wrap.
 *
 * A card is a summary, not a record: it carries what you scan for (is it up, which ports, how long)
 * and the controls you reach for without thinking (start, stop, restart). Everything else — the full
 * command, the error in its own words, the environment — is one click away in the drawer, because a
 * card that tried to hold it all would be a page, and the point of the canvas is to see several at
 * once.
 *
 * The name is a button, because the keyboard needs a real control to open a card's details and the
 * title is the obvious one. With a pointer it is the card's drag handle instead: the canvas already
 * treats a press that never moved as the click that opens a card, so the title has to be grabbable
 * rather than be the one strip of a card that cannot be dragged.
 */
import StatusDot from './StatusDot.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import AppIcon from './AppIcon.jsx';
import { ALIVE, formatUptime, uptimeOf } from '../format.js';

/**
 * @param {{status?: string, selected: boolean, className?: string, leading: import('react').ReactNode,
 *          title: string, trailing?: import('react').ReactNode, openLabel: string,
 *          onOpen: () => void, children?: import('react').ReactNode}} props
 *   `status` tints the card through `--status-color`, which the shared status classes already define
 */
function NodeShell({
  status,
  selected,
  className = '',
  leading,
  title,
  trailing,
  openLabel,
  onOpen,
  children,
}) {
  const classes = ['node', className, status ? `status-${status}` : '', selected ? 'selected' : ''];
  return (
    <article className={classes.filter(Boolean).join(' ')}>
      <div className="node-head">
        {leading}
        <button
          type="button"
          className="node-open"
          // Also the card's drag handle, so grabbing a card by its name works. That makes the
          // canvas's own press-without-moving the click that opens it, and this handler is left for
          // the keyboard alone — a pointer click here would otherwise open the card twice, and
          // worse, open it at the end of a drag.
          data-drag-handle=""
          onClick={(event) => {
            if (event.detail === 0) onOpen();
          }}
          title={openLabel}
        >
          <span className="node-name">{title}</span>
        </button>
        {trailing}
      </div>
      {children && <div className="node-body">{children}</div>}
    </article>
  );
}

/** A process's own favicon where it has one, and the glyph for what it is where it has not. */
function NodeMark({ favicon, glyph }) {
  return (
    <span className="node-mark" aria-hidden="true">
      {favicon ? <img src={favicon} alt="" /> : <Icon name={glyph} size={14} />}
    </span>
  );
}

/**
 * The application itself: what the cards to its right belong to. It states and never acts — every
 * lifecycle control for the whole application is in the page's top bar, one place only.
 * @param {{application: object, favicons: Record<string, object>, selected: boolean,
 *          onOpen: () => void}} props
 */
export function ApplicationNode({ application, favicons, selected, onOpen }) {
  const counts = application.processCounts;
  return (
    <NodeShell
      className="node-application"
      status={application.status}
      selected={selected}
      leading={<AppIcon application={application} favicons={favicons} size="sm" />}
      title={application.name}
      trailing={<StatusDot status={application.status} />}
      openLabel={`Details of ${application.name}`}
      onOpen={onOpen}
    >
      <p className="node-line">
        {application.kind === 'postgres' ? 'PostgreSQL server' : 'Application'}
        {application.autoStart && <span className="tag">starts with Paddock</span>}
      </p>
      <p className="node-facts">
        <span>{counts.running}/{counts.enabled} running</span>
        <span>{counts.total} configured</span>
      </p>
    </NodeShell>
  );
}

/**
 * One process. Its controls are on the card because starting and stopping is most of what anyone
 * does here; a process cannot be started twice, but it must always be stoppable — the manager keeps
 * the process group after a crash, and that group can still be holding a port.
 * @param {{process: object, favicon: string|undefined, now: number, busy: boolean, stale: boolean,
 *          selected: boolean, onAction: (action: string) => void, onOpen: () => void}} props
 */
export function ProcessNode({ process, favicon, now, busy, stale, selected, onAction, onOpen }) {
  const startable = !busy && process.status !== 'running' && process.status !== 'starting';
  const uptime = uptimeOf(process, now);
  const alive = ALIVE.has(process.status);

  return (
    <NodeShell
      className={`node-process${process.enabled ? '' : ' disabled'}`}
      status={process.status}
      selected={selected}
      leading={<NodeMark favicon={favicon} glyph="terminal" />}
      title={process.name}
      trailing={
        <>
          {process.lastError && (
            <Icon name="alert" size={14} className="node-alarm" title="Last start reported an error" />
          )}
          <StatusDot status={process.status} />
        </>
      }
      openLabel={`Details of ${process.name}`}
      onOpen={onOpen}
    >
      <p className="node-line">
        {/* `null` means no port scan has run yet, which is not the same as listening on nothing. */}
        {process.ports?.length ? (
          process.ports.map((port) => <span key={port} className="port-chip">:{port}</span>)
        ) : (
          <span className="node-idle">{alive ? 'no ports found' : 'not listening'}</span>
        )}
        {!process.enabled && <span className="tag">disabled</span>}
      </p>

      {stale && (
        <p className="node-notice">
          <span>On the old configuration</span>
          <button type="button" className="btn small" onClick={() => onAction('restart')}>
            <Icon name="restart" />
            Restart
          </button>
        </p>
      )}

      <div className="node-foot">
        <span className="node-facts">
          {Number.isFinite(uptime) && <span>{alive ? 'up' : 'ran'} {formatUptime(uptime)}</span>}
          {process.pid != null && <span>pid {process.pid}</span>}
          {process.restarts > 0 && <span>{process.restarts} restarts</span>}
        </span>
        <span className="button-group small" role="group" aria-label={`${process.name} controls`}>
          <IconButton
            icon="play"
            label={`Start ${process.name}`}
            className="small"
            disabled={!startable}
            onClick={() => onAction('start')}
          />
          <IconButton
            icon="stop"
            label={`Stop ${process.name}`}
            className="small"
            disabled={busy}
            onClick={() => onAction('stop')}
          />
          <IconButton
            icon="restart"
            label={`Restart ${process.name}`}
            className="small"
            disabled={busy}
            onClick={() => onAction('restart')}
          />
        </span>
      </div>
    </NodeShell>
  );
}

/**
 * Where the database tools connect, as a URL to paste into psql. The password is never in the view,
 * so it is never in the URL either.
 * @param {{settings: object, selected: boolean, onOpen: () => void}} props the `postgres` view
 */
export function ConnectionNode({ settings, selected, onOpen }) {
  const url = `postgresql://${settings.user}@${settings.host}:${settings.port}/${settings.maintenanceDatabase}`;
  return (
    <NodeShell
      className="node-connection"
      selected={selected}
      leading={<NodeMark glyph="database" />}
      title="Connection"
      trailing={settings.passwordSet ? <span className="tag">password saved</span> : null}
      openLabel="Connection details"
      onOpen={onOpen}
    >
      <code className="node-url" title={url}>{url}</code>
    </NodeShell>
  );
}

/**
 * The slot an application has not filled yet — a PostgreSQL server that is not defined, a process
 * list with nothing in it. The whole card is the control, and it is the one thing on an otherwise
 * empty canvas, so it is the one thing carrying the accent.
 *
 * Being a button end to end is also what keeps it out of the canvas's gestures: it cannot be
 * dragged, which is right for a card that disappears the moment it is used.
 * @param {{image?: string, title: string, hint: string, onClick: () => void}} props
 */
export function PlaceholderNode({ image, title, hint, onClick }) {
  return (
    <article className="node node-placeholder">
      <button type="button" className="node-placeholder-box" onClick={onClick}>
        <span className="node-placeholder-mark">
          {image ? <img src={image} alt="" /> : <Icon name="plus" size={22} />}
        </span>
        <span className="node-placeholder-title">{title}</span>
        <span className="hint">{hint}</span>
      </button>
    </article>
  );
}
