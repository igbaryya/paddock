/**
 * One process as a tile: its state, where it runs from, what it runs, and the controls that act on
 * it — small enough that several sit side by side and the log below keeps the height.
 *
 * Paths are cut from the front and commands from the back, each with the whole value on its
 * tooltip: "which checkout is this serving" is answered by the end of a path, and "what is this
 * running" by the start of a command.
 */
import StatusDot from './StatusDot.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';

/** A process being brought up is already burning wall-clock time, so it counts as up. */
const ALIVE = new Set(['starting', 'running', 'stopping']);

const formatUptime = (ms) => {
  // `null` before the first start, and NaN if `startedAt` is ever unparseable — neither is a number
  // of seconds, and printing "NaNs" in a status column is worse than printing nothing.
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1_000);
  const [d, h, m, s] = [Math.floor(total / 86_400), Math.floor(total / 3_600) % 24,
    Math.floor(total / 60) % 60, total % 60];
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
};

/** While the process is alive its uptime is derived from the clock, so it keeps counting. */
const uptimeOf = (process, now) =>
  ALIVE.has(process.status) && process.startedAt
    ? now - Date.parse(process.startedAt)
    : process.uptimeMs;

const exitSummary = (process) => {
  if (process.exitSignal) return `exit on ${process.exitSignal}`;
  if (process.exitCode != null) return `exit ${process.exitCode}`;
  return null;
};

/** @param {{process: object, busy: boolean, onAction: (action: string) => void}} props */
function LifecycleButtons({ process, busy, onAction }) {
  // A process cannot be started twice, but it must always be stoppable: the manager keeps the
  // process group around after a crash, and that group can still be holding a port.
  const startable = !busy && process.status !== 'running' && process.status !== 'starting';
  const { name } = process;
  return (
    <span className="button-group small" role="group" aria-label={`${name} controls`}>
      <IconButton icon="play" label={`Start ${name}`} className="small" disabled={!startable} onClick={() => onAction('start')} />
      <IconButton icon="stop" label={`Stop ${name}`} className="small" disabled={busy} onClick={() => onAction('stop')} />
      <IconButton icon="restart" label={`Restart ${name}`} className="small" disabled={busy} onClick={() => onAction('restart')} />
    </span>
  );
}

/**
 * A path whose end is what identifies it, so the overflow is taken from its start.
 * @param {{path: string, label: string, mark: import('react').ReactNode}} props `label` names the
 *   path on its tooltip; `mark` is what sits in the prompt column
 */
const PathLine = ({ path, label, mark }) => (
  <span className="tile-line tile-path">
    <span className="tile-prompt" aria-hidden="true">{mark}</span>
    <span className="tile-value from-end" title={`${label}: ${path}`}>
      <code dir="ltr">{path}</code>
    </span>
  </span>
);

/**
 * Where the process runs from and what it runs, the way a terminal would show them: a folder, then
 * a prompt. The glyphs replace the REPO / RUN labels, which cost a column of the tile's width.
 * @param {{process: object, pathLabel: string}} props
 */
function Source({ process, pathLabel }) {
  const cwd = process.workingDirectory !== process.repositoryPath ? process.workingDirectory : null;
  return (
    <div className="tile-well tile-source">
      <PathLine path={process.repositoryPath} label={pathLabel} mark={<Icon name="folder" size={12} />} />
      {cwd && <PathLine path={cwd} label="cwd" mark="↳" />}
      <span className="tile-line">
        <span className="tile-prompt" aria-hidden="true">$</span>
        <code className="tile-value" title={process.command}>{process.command}</code>
      </span>
    </div>
  );
}

/**
 * The status word and the numbers that tick. Anything not known yet — no pid, never started — is
 * left out rather than drawn as a dash: in a tile this size a row of dashes is all anyone would see.
 * @param {{process: object, now: number}} props
 */
function Runtime({ process, now }) {
  const uptime = uptimeOf(process, now);
  const envCount = Object.keys(process.env ?? {}).length;
  const exit = exitSummary(process);
  return (
    <span className="tile-runtime">
      {/* The status class only sets `--status-color`, which the word is drawn in. */}
      <span className={`tile-status status-${process.status}`}>{process.status}</span>
      {Number.isFinite(uptime) && (
        <span>{ALIVE.has(process.status) ? 'up' : 'ran'} {formatUptime(uptime)}</span>
      )}
      {process.pid != null && <span>pid {process.pid}</span>}
      {process.restarts > 0 && <span>{process.restarts} restarts</span>}
      {envCount > 0 && <span>{envCount} env</span>}
      {exit && <span>{exit}</span>}
    </span>
  );
}

/**
 * @param {{process: object, now: number, busy: boolean, stale: boolean, pathLabel?: string,
 *          onAction: (action: string) => void, onEdit: (() => void)|null,
 *          onDelete: (() => void)|null}} props `onDelete` is null for a process that is derived
 *   rather than configured — a PostgreSQL server, whose `onEdit` opens the settings it is derived
 *   from — and a null handler's button is not drawn
 */
export default function ProcessTile({
  process,
  now,
  busy,
  stale,
  pathLabel = 'repo',
  onAction,
  onEdit,
  onDelete,
}) {
  return (
    <li className={`process-tile${process.enabled ? '' : ' disabled'}`}>
      <div className="tile-head">
        <StatusDot status={process.status} />
        <span className="process-name" title={process.name}>{process.name}</span>
        {!process.enabled && <span className="tag">disabled</span>}
        {/* `null` means no port scan has run yet, which is not the same as listening on nothing. */}
        {process.ports?.map((port) => (
          <span key={port} className="port-chip">:{port}</span>
        ))}
        <span className="spacer" />
        <LifecycleButtons process={process} busy={busy} onAction={onAction} />
      </div>

      <Source process={process} pathLabel={pathLabel} />

      {process.lastError && (
        <p className="process-error" title={process.lastError}><span>{process.lastError}</span></p>
      )}

      {stale && (
        <p className="process-notice">
          <span>Still on the old configuration.</span>
          <button type="button" className="btn small" onClick={() => onAction('restart')}>
            <Icon name="restart" />
            Restart to apply
          </button>
        </p>
      )}

      <div className="tile-foot">
        <Runtime process={process} now={now} />
        <span className="tile-buttons">
          {onEdit && (
            <IconButton icon="pencil" label={`Edit ${process.name}`} className="small ghost" onClick={onEdit} />
          )}
          {onDelete && (
            <IconButton icon="trash" label={`Delete ${process.name}`} className="small ghost danger" onClick={onDelete} />
          )}
        </span>
      </div>
    </li>
  );
}
