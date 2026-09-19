/**
 * What the drawer shows for the selected card: everything the card itself had no room for.
 *
 * The three kinds of card each get the tabs that make sense for them, and only those — a connection
 * has no output to tail, so it has no Output tab rather than an empty one. The tabs are where the
 * page's own long-lived views now live: the log tail and the SQL console are the same components the
 * page used to stack vertically, moved in here so the canvas keeps the window.
 *
 * Nothing in here mutates anything itself. Editing opens the form the rest of the app already uses,
 * so there is one definition of what a process is allowed to be — and the lifecycle controls stay on
 * the card, where they were already within reach.
 */
import { useState } from 'react';
import StatusDot from './StatusDot.jsx';
import Icon from './Icon.jsx';
import CopyButton from './CopyButton.jsx';
import LogViewer from './LogViewer.jsx';
import SqlConsole from './SqlConsole.jsx';
import Drawer, { DrawerEmpty, DrawerFacts, DrawerSection } from './Drawer.jsx';
import { ALIVE, exitSummary, formatUptime, uptimeOf } from '../format.js';

const OUTPUT_TAB = { id: 'output', label: 'Output' };
const OVERVIEW_TAB = { id: 'overview', label: 'Overview' };

const formatWhen = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
};

/** A path or a command, whole: the card could only show one end of it, and this is the other place. */
const Machine = ({ value }) => <code className="drawer-machine">{value}</code>;

/**
 * @param {{process: object, now: number, stale: boolean, derived: boolean,
 *          onAction: (action: string) => void, onEdit: (() => void)|null,
 *          onDelete: (() => void)|null}} props
 *   `derived` marks a PostgreSQL application's one process: its configuration comes from the
 *   server's settings, so it is edited there and cannot be deleted on its own.
 */
function ProcessOverview({ process, now, stale, derived, onAction, onEdit, onDelete }) {
  const uptime = uptimeOf(process, now);
  const exit = exitSummary(process);
  const env = Object.entries(process.env ?? {});
  const cwd = process.workingDirectory !== process.repositoryPath ? process.workingDirectory : null;

  return (
    <>
      {process.lastError && (
        <p className="notice danger" role="alert">
          <Icon name="alert" />
          <span>{process.lastError}</span>
        </p>
      )}

      {stale && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>Running on the configuration it was started with, not the one saved.</span>
          <button type="button" className="btn small" onClick={() => onAction('restart')}>
            <Icon name="restart" />
            Restart to apply
          </button>
        </p>
      )}

      <DrawerSection title="State">
        <DrawerFacts
          rows={[
            { label: 'Status', value: <StatusDot status={process.status} showLabel /> },
            {
              label: ALIVE.has(process.status) ? 'Up for' : 'Ran for',
              value: Number.isFinite(uptime) ? formatUptime(uptime) : '—',
              mono: true,
            },
            { label: 'Pid', value: process.pid ?? '—', mono: true },
            { label: 'Restarts', value: process.restarts, mono: true },
            ...(exit ? [{ label: 'Exit', value: exit, mono: true }] : []),
            {
              label: 'Ports',
              // Null means no scan has happened yet, which is not the same as listening on nothing.
              value: process.ports === null
                ? 'not scanned yet'
                : process.ports.length === 0
                  ? 'none'
                  : process.ports.map((port) => (
                      <span key={port} className="port-chip">:{port}</span>
                    )),
            },
            { label: 'Enabled', value: process.enabled ? 'yes' : 'no' },
          ]}
        />
      </DrawerSection>

      <DrawerSection
        title="Source"
        action={
          onEdit && (
            <button type="button" className="btn small" onClick={onEdit}>
              <Icon name="pencil" />
              {derived ? 'Edit server' : 'Edit'}
            </button>
          )
        }
      >
        <DrawerFacts
          rows={[
            {
              label: derived ? 'Data' : 'Repository',
              value: <Machine value={process.repositoryPath} />,
            },
            ...(cwd ? [{ label: 'Working dir', value: <Machine value={cwd} /> }] : []),
            { label: 'Command', value: <Machine value={process.command} /> },
          ]}
        />
      </DrawerSection>

      <DrawerSection title="Environment">
        {env.length === 0 ? (
          <DrawerEmpty>
            Nothing set here — the process inherits Paddock&apos;s own environment.
          </DrawerEmpty>
        ) : (
          <DrawerFacts
            rows={env.map(([key, value]) => ({ label: key, value: <Machine value={value} />, mono: true }))}
          />
        )}
      </DrawerSection>

      {onDelete && (
        <DrawerSection title="Remove">
          <p className="hint">The process is stopped first, and its logs go with it.</p>
          <button type="button" className="btn small danger" onClick={onDelete}>
            <Icon name="trash" />
            Delete {process.name}
          </button>
        </DrawerSection>
      )}
    </>
  );
}

/** @param {{application: object}} props */
function ApplicationOverview({ application, onEdit, onDelete, onAddProcess }) {
  const counts = application.processCounts;
  const postgres = application.kind === 'postgres';

  return (
    <>
      {application.description && <p className="drawer-intro">{application.description}</p>}

      <DrawerSection
        title="Application"
        action={
          <button type="button" className="btn small" onClick={onEdit}>
            <Icon name="pencil" />
            Edit
          </button>
        }
      >
        <DrawerFacts
          rows={[
            { label: 'Status', value: <StatusDot status={application.status} showLabel /> },
            { label: 'Kind', value: postgres ? 'PostgreSQL server' : 'Processes' },
            {
              label: 'Processes',
              value: `${counts.running}/${counts.enabled} running · ${counts.total} configured`,
            },
            { label: 'At login', value: application.autoStart ? 'starts with Paddock' : 'no' },
            { label: 'Created', value: formatWhen(application.createdAt) },
            { label: 'Updated', value: formatWhen(application.updatedAt) },
          ]}
        />
      </DrawerSection>

      {!postgres && (
        <DrawerSection title="Add">
          <p className="hint">
            A process is a repository path and the command that starts it there.
          </p>
          <button type="button" className="btn small" onClick={onAddProcess}>
            <Icon name="plus" />
            Add process
          </button>
        </DrawerSection>
      )}

      <DrawerSection title="Remove">
        <p className="hint">
          {postgres
            ? 'Paddock forgets the server. The cluster itself is left exactly as it is — running or not.'
            : 'Every process is stopped first, and their logs go with them.'}
        </p>
        <button type="button" className="btn small danger" onClick={onDelete}>
          <Icon name="trash" />
          Delete {application.name}
        </button>
      </DrawerSection>
    </>
  );
}

/** @param {{settings: object}} props the application's `postgres` view */
function ConnectionOverview({ settings, onEdit }) {
  const url = `postgresql://${settings.user}@${settings.host}:${settings.port}/${settings.maintenanceDatabase}`;
  return (
    <>
      <DrawerSection
        title="Connection"
        action={<CopyButton text={url} label="Copy the connection URL" />}
      >
        <DrawerFacts
          rows={[
            { label: 'URL', value: <Machine value={url} /> },
            { label: 'Host', value: settings.host, mono: true },
            { label: 'Port', value: settings.port, mono: true },
            { label: 'User', value: settings.user, mono: true },
            { label: 'Database', value: settings.maintenanceDatabase, mono: true },
            { label: 'Password', value: settings.passwordSet ? 'saved' : 'none' },
          ]}
        />
      </DrawerSection>

      <DrawerSection
        title="Cluster"
        action={
          <button type="button" className="btn small" onClick={onEdit}>
            <Icon name="pencil" />
            Edit server
          </button>
        }
      >
        <DrawerFacts
          rows={[
            { label: 'Data', value: <Machine value={settings.dataDirectory} /> },
            {
              label: 'Binaries',
              value: <Machine value={settings.binDirectory ?? 'pg_ctl on PATH'} />,
            },
            { label: 'Log', value: <Machine value={settings.logFile ?? "Paddock's own"} /> },
          ]}
        />
        <p className="hint">
          Run with pg_ctl, outside Paddock: it keeps running when Paddock stops, and a server started
          from a terminal shows here as running.
        </p>
      </DrawerSection>
    </>
  );
}

/**
 * @param {{application: object, favicons: Record<string, object>, selection: {kind: string, id: string},
 *          logs: object[], now: number, staleProcesses: string[], onClose: () => void,
 *          onClearLogs: () => void, onProcessAction: (id: string, action: string) => void,
 *          onEdit: () => void, onDelete: () => void, onAddProcess: () => void,
 *          onEditProcess: (process: object) => void, onDeleteProcess: (process: object) => void,
 *          onEditPostgres: () => void}} props
 */
export default function NodeDetails({
  application,
  selection,
  logs,
  now,
  staleProcesses,
  onClose,
  onClearLogs,
  onProcessAction,
  onEdit,
  onDelete,
  onAddProcess,
  onEditProcess,
  onDeleteProcess,
  onEditPostgres,
}) {
  const [tab, setTab] = useState(OVERVIEW_TAB.id);

  if (selection.kind === 'connection') {
    // The card can go while its drawer is open, and a server that is no longer defined has no
    // connection to describe.
    if (!application.postgres) return null;
    return (
      <Drawer
        leading={<Icon name="database" />}
        title="Connection"
        subtitle="Where the database tools reach this server"
        onClose={onClose}
      >
        <ConnectionOverview settings={application.postgres} onEdit={onEditPostgres} />
      </Drawer>
    );
  }

  if (selection.kind === 'application') {
    // The console belongs to a server, so it is only offered once there is one to query.
    const tabs = [
      OVERVIEW_TAB,
      OUTPUT_TAB,
      ...(application.postgres ? [{ id: 'sql', label: 'SQL' }] : []),
    ];
    return (
      <Drawer
        title={application.name}
        subtitle={<StatusDot status={application.status} showLabel />}
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        onClose={onClose}
      >
        {tab === 'overview' && (
          <ApplicationOverview
            application={application}
            onEdit={onEdit}
            onDelete={onDelete}
            onAddProcess={onAddProcess}
          />
        )}
        {tab === 'output' && (
          <LogViewer application={application} logs={logs} onClear={onClearLogs} />
        )}
        {tab === 'sql' && <SqlConsole application={application} />}
      </Drawer>
    );
  }

  const process = application.processes.find((one) => one.id === selection.id);
  // The card can go while its drawer is open — a process deleted, or a server undefined.
  if (!process) return null;
  // A PostgreSQL application's one process is derived from its settings: those are what Edit opens,
  // and there is no list to delete it from.
  const derived = application.kind === 'postgres';

  return (
    <Drawer
      leading={<Icon name={derived ? 'database' : 'terminal'} />}
      title={process.name}
      subtitle={<StatusDot status={process.status} showLabel />}
      tabs={[OVERVIEW_TAB, OUTPUT_TAB]}
      activeTab={tab}
      onTabChange={setTab}
      onClose={onClose}
    >
      {tab === 'overview' && (
        <ProcessOverview
          process={process}
          now={now}
          stale={staleProcesses.includes(process.id)}
          derived={derived}
          onAction={(action) => onProcessAction(process.id, action)}
          onEdit={derived ? onEditPostgres : () => onEditProcess(process)}
          onDelete={derived ? null : () => onDeleteProcess(process)}
        />
      )}
      {tab === 'output' && (
        <LogViewer
          application={application}
          logs={logs}
          onClear={onClearLogs}
          processId={process.id}
        />
      )}
    </Drawer>
  );
}
