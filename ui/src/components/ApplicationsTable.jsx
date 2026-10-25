/**
 * The overview as a table: one row per application, and under it — opened as a tree branching off the
 * application — the services it runs. A row answers "is this up, how much of it, and on which ports" without being
 * opened; opening it answers "which one is down, and why", with each service's own controls.
 *
 * Clicking anywhere on a row that is not a control toggles it. The name is a link to the
 * application's page, so the canvas is still one click away. Which rows are open is remembered in
 * this browser, so the overview comes back the way it was left.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import AppIcon from './AppIcon.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import StatusDot from './StatusDot.jsx';
import WebLink from './WebLink.jsx';
import { ALIVE, exitSummary, formatUptime, uptimeOf } from '../format.js';
import { Link, paths } from '../router.jsx';
import { useSecondsTick } from '../useSecondsTick.js';

const STORAGE_KEY = 'paddock.overview.expanded';

/** A row with more ports than this shows the rest as a count. */
const PORTS_SHOWN = 3;

const ACTIONS = [
  ['start', 'play', 'Start'],
  ['stop', 'stop', 'Stop'],
  ['restart', 'restart', 'Restart'],
];

function readExpanded() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

/** Every port any of its services holds, once each, in order. */
const portsOf = (application) =>
  [...new Set(application.processes.flatMap((process) => process.ports ?? []))].sort((a, b) => a - b);

/** @param {{ports: number[]}} props */
function PortChips({ ports }) {
  if (!ports.length) return <span className="empty-text">—</span>;
  const extra = ports.length - PORTS_SHOWN;
  return (
    <span className="apps-ports">
      {ports.slice(0, PORTS_SHOWN).map((port) => (
        <span key={port} className="port-chip">:{port}</span>
      ))}
      {extra > 0 && (
        <span className="apps-more" title={ports.slice(PORTS_SHOWN).map((p) => `:${p}`).join(' ')}>
          +{extra}
        </span>
      )}
    </span>
  );
}

/** One glyph per service, so a 3-of-4 reads as which three without opening the row. */
function ServiceStrip({ application }) {
  const counts = application.processCounts;
  if (application.processes.length === 0) {
    return <span className="empty-text">{application.kind === 'postgres' ? 'Not defined' : 'None yet'}</span>;
  }
  return (
    <span className="apps-services">
      <span className="apps-strip" aria-hidden="true">
        {application.processes.map((process) => (
          <StatusDot key={process.id} status={process.status} />
        ))}
      </span>
      <span className="apps-count">
        {counts.running}/{counts.enabled} running
      </span>
    </span>
  );
}

/**
 * @param {{application: object, now: number, isBusy: (id: string) => boolean,
 *          onProcessAction: (processId: string, action: string) => void,
 *          onEditProcess: (process: object) => void}} props
 */
function Services({ application, now, isBusy, onProcessAction, onEditProcess }) {
  if (application.processes.length === 0) {
    return (
      <p className="apps-empty">
        {application.kind === 'postgres'
          ? 'The PostgreSQL server is not defined yet.'
          : 'No services configured yet.'}{' '}
        <Link to={paths.application(application.id)}>Open {application.name}</Link> to add one.
      </p>
    );
  }

  return (
    <ul className="apps-service-list">
      {application.processes.map((process) => {
        const alive = ALIVE.has(process.status);
        const busy = isBusy(process.id);
        const problem = process.status === 'crashed' || process.status === 'failed';
        const detail = problem ? process.lastError ?? exitSummary(process) : null;
        return (
          <li key={process.id} className={`apps-service${process.enabled ? '' : ' disabled'}`}>
            <StatusDot status={process.status} />
            <div className="apps-service-main">
              <span className="apps-service-name">
                {process.name}
                {!process.enabled && <span className="tag">disabled</span>}
              </span>
              <code className="apps-service-command" title={process.command}>
                {process.command}
              </code>
              {detail && <span className="apps-service-error">{detail}</span>}
            </div>
            <code className="apps-service-dir" title={process.workingDirectory}>
              {process.workingDirectory}
            </code>
            <span className="apps-service-meta">{process.pid ? `pid ${process.pid}` : '—'}</span>
            <span className="apps-service-meta">{alive ? formatUptime(uptimeOf(process, now)) : '—'}</span>
            <PortChips ports={process.ports ?? []} />
            <span className="apps-actions-inline">
              {process.web && <WebLink web={process.web} name={process.name} />}
              <span className="button-group small" role="group" aria-label={`${process.name} controls`}>
                {ACTIONS.map(([action, icon, verb]) => (
                  <IconButton
                    key={action}
                    icon={icon}
                    label={`${verb} ${process.name}`}
                    className="small"
                    disabled={
                      busy ||
                      (action === 'start' && alive) ||
                      (action === 'stop' && process.status === 'stopped')
                    }
                    onClick={() => onProcessAction(process.id, action)}
                  />
                ))}
              </span>
              <IconButton
                icon="pencil"
                label={application.kind === 'postgres' ? 'Edit the PostgreSQL server' : `Edit ${process.name}`}
                className="small ghost"
                onClick={() => onEditProcess(process)}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * @param {{applications: object[], favicons: Record<string, object>, isBusy: (id: string) => boolean,
 *          onAction: (applicationId: string, action: string) => void,
 *          onProcessAction: (applicationId: string, processId: string, action: string) => void,
 *          onEdit: (application: object) => void,
 *          onEditProcess: (application: object, process: object) => void}} props
 */
export default function ApplicationsTable({
  applications,
  favicons,
  isBusy,
  onAction,
  onProcessAction,
  onEdit,
  onEditProcess,
}) {
  const [expanded, setExpanded] = useState(readExpanded);
  const [query, setQuery] = useState('');
  const now = useSecondsTick();

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded]));
    } catch {
      // Not remembered, but still open for this visit.
    }
  }, [expanded]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return applications;
    return applications.filter((application) =>
      [
        application.name,
        application.description,
        ...application.processes.flatMap((process) => [process.name, process.command]),
      ].some((text) => text?.toLowerCase().includes(needle))
    );
  }, [applications, query]);

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = rows.length > 0 && rows.every((application) => expanded.has(application.id));
  const setAll = (open) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const application of rows) {
        if (open) next.add(application.id);
        else next.delete(application.id);
      }
      return next;
    });

  /** A click on the row's own surface toggles it; one on a link or a button does what that control does. */
  const onRowClick = (event, id) => {
    if (event.target.closest('a, button, input')) return;
    toggle(id);
  };

  return (
    <section className="panel apps-panel">
      <div className="panel-head">
        <div className="search-wrap">
          <Icon name="search" size={14} className="search-icon" />
          <input
            type="search"
            className="search"
            placeholder="Filter by application, service or command"
            aria-label="Filter applications"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="spacer" />
        <span className="meta">
          {rows.length}
          {rows.length === applications.length ? '' : ` of ${applications.length}`} shown
        </span>
        <button type="button" className="btn small ghost" onClick={() => setAll(!allOpen)} disabled={!rows.length}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="empty-inline">No applications match.</p>
      ) : (
        <div className="table-scroll">
          <table className="apps-table">
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col">Status</th>
                <th scope="col">Services</th>
                <th scope="col">Ports</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((application) => {
                const open = expanded.has(application.id);
                const busy = isBusy(application.id);
                const panelId = `apps-services-${application.id}`;
                const site = application.processes.find((process) => process.web);
                return (
                  <Fragment key={application.id}>
                    <tr
                      className={`apps-row${open ? ' open' : ''}`}
                      onClick={(event) => onRowClick(event, application.id)}
                    >
                      <td>
                        <div className="apps-name-cell">
                          <button
                            type="button"
                            className="apps-toggle"
                            aria-expanded={open}
                            aria-controls={panelId}
                            aria-label={`${open ? 'Hide' : 'Show'} the services of ${application.name}`}
                            onClick={() => toggle(application.id)}
                          >
                            <Icon name="chevron" size={14} />
                          </button>
                          <AppIcon application={application} favicons={favicons} size="sm" />
                          <div className="apps-heading">
                            <Link to={paths.application(application.id)} className="apps-name">
                              {application.name}
                            </Link>
                            <span className="apps-desc">
                              {application.kind === 'postgres' && <span className="tag">PostgreSQL</span>}
                              {application.description || (
                                application.kind !== 'postgres' && <span className="empty-text">No description</span>
                              )}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <StatusDot status={application.status} showLabel />
                      </td>
                      <td>
                        <ServiceStrip application={application} />
                      </td>
                      <td>
                        <PortChips ports={portsOf(application)} />
                      </td>
                      <td className="apps-actions">
                        {site && (
                          <WebLink
                            web={site.web}
                            name={application.processes.length > 1 ? `${application.name} — ${site.name}` : application.name}
                          />
                        )}
                        <span className="button-group small" role="group" aria-label={`${application.name} controls`}>
                          {ACTIONS.map(([action, icon, verb]) => (
                            <IconButton
                              key={action}
                              icon={icon}
                              label={`${verb} ${application.name}`}
                              className={`small${
                                action === 'start' &&
                                application.status !== 'running' &&
                                application.processes.length > 0
                                  ? ' accent'
                                  : ''
                              }`}
                              disabled={busy}
                              onClick={() => onAction(application.id, action)}
                            />
                          ))}
                        </span>
                        <IconButton
                          icon="pencil"
                          label={`Edit ${application.name}`}
                          className="small ghost"
                          onClick={() => onEdit(application)}
                        />
                      </td>
                    </tr>
                    {open && (
                      <tr className="apps-detail-row" id={panelId}>
                        <td colSpan={5}>
                          <Services
                            application={application}
                            now={now}
                            isBusy={isBusy}
                            onProcessAction={(processId, action) =>
                              onProcessAction(application.id, processId, action)
                            }
                            onEditProcess={(process) => onEditProcess(application, process)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
