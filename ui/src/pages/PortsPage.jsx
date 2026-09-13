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

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Local ports</h1>
          <p className="page-sub">
            What is listening on this machine, and which of it belongs to an application here.
          </p>
        </div>
        <button type="button" className="btn" onClick={onRefresh}>
          <Icon name="refresh" />
          Refresh
        </button>
      </header>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{rows === null ? '—' : rows.length}</span>
          <span className="stat-label">listening</span>
        </div>
        <div className="stat">
          <span className="stat-value stat-ok">{rows === null ? '—' : managed}</span>
          <span className="stat-label">managed here</span>
        </div>
        <div className="stat">
          <span className={`stat-value${exposed ? ' stat-warn' : ''}`}>
            {rows === null ? '—' : exposed}
          </span>
          <span className="stat-label">reachable off-machine</span>
        </div>
        <div className="stat">
          <span className="stat-value stat-time">
            {ports.scannedAt ? new Date(ports.scannedAt).toLocaleTimeString() : '—'}
          </span>
          <span className="stat-label">last scan</span>
        </div>
      </div>

      {ports.degraded?.map((note) => (
        <p key={note} className="notice warn">
          <Icon name="alert" />
          <span>{note}</span>
        </p>
      ))}

      <section className="panel">
        <div className="toolbar">
          <div className="search-wrap">
            <Icon name="search" size={14} className="search-icon" />
            <input
              type="search"
              className="search"
              placeholder="Filter by port, pid, process or command…"
              aria-label="Filter ports"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="segmented" role="group" aria-label="Show">
            {[
              ['all', 'All'],
              ['managed', 'Managed'],
              ['exposed', 'Exposed'],
            ].map(([value, label]) => (
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
