/**
 * Every listening TCP port on the machine, on its own page — it is a property of the machine, not
 * of any one application, and it is where you land when something will not bind.
 *
 * The filter is the reason this is a page rather than a panel: on a working developer's machine
 * this table is thirty rows of editors, Docker and language servers, and the one you care about is
 * found by typing a port number.
 */
import { useMemo, useState } from 'react';
import PortsTable from '../components/PortsTable.jsx';
import Icon from '../components/Icon.jsx';
import Stat from '../components/Stat.jsx';
import Toolbar from '../components/Toolbar.jsx';

const FILTERS = [
  ['all', 'All'],
  ['managed', 'Managed'],
  ['exposed', 'Exposed'],
];

/**
 * @param {{ports: object, isBusy: (port: number) => boolean, onRefresh: Function,
 *          onStopPort: Function, onProcessAction: Function}} props
 */
export default function PortsPage({ ports, isBusy, onRefresh, onStopPort, onProcessAction }) {
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState('all');

  const rows = ports.ports;

  const filtered = useMemo(() => {
    if (rows === null) return null;
    const needle = query.trim().toLowerCase();
    return rows.filter((usage) => {
      if (only === 'managed' && usage.owner.kind !== 'managed') return false;
      if (only === 'exposed' && !usage.exposed) return false;
      if (!needle) return true;
      // Matching the command line too is what makes "vite" or a repository name find the row.
      return [
        String(usage.port),
        String(usage.pid ?? ''),
        usage.processName ?? '',
        usage.commandLine ?? '',
        usage.owner.applicationName ?? '',
        usage.owner.processName ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, query, only]);

  const managed = (rows ?? []).filter((p) => p.owner.kind === 'managed').length;
  const exposed = (rows ?? []).filter((p) => p.exposed).length;
  const count = (value) => (rows === null ? '—' : value);

  return (
    <>
      <Toolbar
        title="Local ports"
        subtitle="What is listening on this machine, and which of it belongs to an application here."
      >
        <button type="button" className="btn" onClick={onRefresh}>
          <Icon name="refresh" />
          Refresh
        </button>
      </Toolbar>

      <div className="stat-row">
        <Stat icon="ports" value={count(rows?.length)} label="listening" />
        <Stat icon="check" value={count(managed)} label="managed here" tone="ok" />
        <Stat
          icon="globe"
          value={count(exposed)}
          label="reachable off-machine"
          tone={exposed ? 'warn' : undefined}
        />
        <Stat
          icon="clock"
          value={ports.scannedAt ? new Date(ports.scannedAt).toLocaleTimeString() : '—'}
          label="last scan"
        />
      </div>

      {ports.degraded?.map((note) => (
        <p key={note} className="notice warn">
          <Icon name="alert" />
          <span>{note}</span>
        </p>
      ))}

      <section className="panel ports">
        <div className="panel-head">
          <div className="search-wrap">
            <Icon name="search" size={14} className="search-icon" />
            <input
              type="search"
              className="search"
              placeholder="Filter by port, pid, process or command"
              aria-label="Filter ports"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="segmented" role="group" aria-label="Show">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`segment${only === value ? ' selected' : ''}`}
                aria-pressed={only === value}
                onClick={() => setOnly(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <span className="meta">
            {filtered === null
              ? 'scanning…'
              : `${filtered.length}${filtered.length === rows.length ? '' : ` of ${rows.length}`} shown`}
          </span>
        </div>

        <PortsTable
          ports={filtered}
          isBusy={isBusy}
          onStopPort={onStopPort}
          onProcessAction={onProcessAction}
        />
      </section>
    </>
  );
}
