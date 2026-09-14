/**
 * The shell: a persistent navigation rail, a routed page, and the dialogs that edit configuration.
 *
 * Every action ends the same way — ask the manager, then refetch and let it report what actually
 * happened — so nothing here keeps an optimistic copy of runtime state that could disagree with the
 * processes on the machine.
 */
import { useCallback, useState } from 'react';
import * as api from './api.js';
import { useLiveState } from './useLiveState.js';
import { navigate, paths, useRoute } from './router.jsx';
import Sidebar from './components/Sidebar.jsx';
import Icon from './components/Icon.jsx';
import ApplicationForm from './components/ApplicationForm.jsx';
import ProcessForm from './components/ProcessForm.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import ApplicationPage from './pages/ApplicationPage.jsx';
import PortsPage from './pages/PortsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

/**
 * `updateProcess` flags the process whose configuration changed under a running instance. The
 * manager will not repeat that flag on a later list, so the dashboard remembers the ids until the
 * process is acted on and the change is actually in effect.
 */
const markedProcessIds = (view) =>
  (view?.processes ?? []).filter((p) => p.configChangedWhileRunning).map((p) => p.id);

/**
 * An application-level start or stop answers 200 with a per-process result list: a process that
 * would not come up is reported in there, not as a failed request. Without this the click looks
 * like it worked and only the row underneath disagrees.
 */
function failureSummary(result) {
  const failed = (result?.results ?? []).filter((one) => !one.ok);
  if (!failed.length) return null;
  return failed.map((one) => `${one.name}: ${one.error ?? one.status}`).join(' · ');
}

export default function App() {
  const route = useRoute();
  const live = useLiveState(route.applicationId ?? null);
  const { applications, selected, logs, connection, reload, ports, refreshPorts } = live;
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [staleProcesses, setStaleProcesses] = useState([]);
  const [busy, setBusy] = useState(() => new Set());

  /**
   * Run one manager command. `key` is the application or process the command belongs to, so only
   * that unit's controls are disabled while it is in flight — stopping one process must not lock
   * the rest of the screen for the length of the shutdown grace period.
   */
  const run = useCallback(
    async (key, operation) => {
      setBusy((prev) => new Set(prev).add(key));
      setActionError(null);
      try {
        return await operation();
      } catch (err) {
        setActionError(err.message); // the manager's own text, never a substitute
        return null;
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        reload();
      }
    },
    [reload]
  );

  const runApplication = async (applicationId, action) => {
    const result = await run(applicationId, () => api.applicationAction(applicationId, action));
    // Only where something was supposed to come up: a process left `crashed` reports `ok: false`,
    // which is the ordinary outcome of stopping it rather than a stop that failed.
    if (action === 'stop') return;
    const summary = failureSummary(result);
    if (summary) setActionError(summary);
  };

  const runProcess = (applicationId, processId, action) =>
    run(processId, async () => {
      const result = await api.processAction(applicationId, processId, action);
      // Whichever of the three ran, the process is now aligned with the configuration on disk.
      setStaleProcesses((ids) => ids.filter((id) => id !== processId));
      return result;
    });

  /**
   * Stop whatever holds a port. The port, not the pid, is what is sent: the manager re-resolves the
   * owner immediately before acting, so a pid from a listing that is seconds old can never be the
   * thing that gets signalled.
   */
  const stopPort = (port) =>
    run(`port:${port}`, async () => {
      const result = await api.stopPort(port);
      if (!result.stopped) {
        const reason = result.reason ?? result.results?.find((r) => !r.stopped)?.reason ?? 'unknown';
        setActionError(
          result.portReleased === false && result.stillHeldBy?.length
            ? `Port ${port} is still held by pid ${result.stillHeldBy.join(', ')} (${reason})`
            : `Could not free port ${port}: ${reason}`
        );
      }
      await refreshPorts({ force: true });
      return result;
    });

  const deleteApplication = (application) => {
    // A PostgreSQL server is not Paddock's to stop on the way out; deleting only forgets it.
    const message = application.kind === 'postgres'
      ? `Delete "${application.name}"? The PostgreSQL server is left as it is — running or not.`
      : `Delete "${application.name}"? Its processes are stopped first.`;
    if (!window.confirm(message)) return;
    // Leave the page first: the route for a deleted application would otherwise render its own
    // "no such application" state, which reads like something went wrong.
    navigate(paths.overview());
    run(application.id, () => api.deleteApplication(application.id));
  };

  const deleteProcess = (applicationId, process) => {
    if (!window.confirm(`Delete "${process.name}"? It is stopped first.`)) return;
    run(process.id, () => api.removeProcess(applicationId, process.id));
  };

  // The forms await these and show the rejection themselves, so failures must propagate.
  const saveApplication = async (values) => {
    const target = dialog.application;
    const view = target
      ? await api.updateApplication(target.id, values)
      : await api.createApplication(values);
    setDialog(null);
    await reload();
    // A new application opens on its own page — it has no processes yet, and that is where they
    // get added.
    if (!target && view?.id) navigate(paths.application(view.id));
  };

  const saveProcess = async (values) => {
    const { applicationId, process: target } = dialog;
    const view = target
      ? await api.updateProcess(applicationId, target.id, values)
      : await api.addProcess(applicationId, values);
    const marked = markedProcessIds(view);
    if (marked.length) setStaleProcesses((ids) => [...new Set([...ids, ...marked])]);
    setDialog(null);
    await reload();
  };

  const openApplicationForm = (application = null) => setDialog({ kind: 'application', application });

  const banner = actionError ?? live.error;
  const dismissBanner = () => {
    setActionError(null);
    live.dismissError();
  };

  return (
    <div className="app">
      <Sidebar
        applications={applications}
        route={route}
        connection={connection}
        portCount={ports.ports?.length ?? null}
        onCreate={() => openApplicationForm()}
      />

      <main className="main">
        {banner && (
          <p className="notice danger" role="alert">
            <Icon name="alert" />
            <span>{banner}</span>
            <button type="button" className="btn ghost small" onClick={dismissBanner}>
              <Icon name="close" />
              <span className="sr-only">Dismiss</span>
            </button>
          </p>
        )}

        {route.name === 'overview' && (
          <OverviewPage
            applications={applications}
            ports={ports}
            busy={busy}
            onCreate={() => openApplicationForm()}
            onAction={runApplication}
          />
        )}

        {route.name === 'application' && (
          <ApplicationPage
            application={selected}
            /* The list having arrived is what turns "still loading" into "no such application". */
            loaded={applications.length > 0}
            logs={logs}
            busy={busy}
            staleProcesses={staleProcesses}
            onClearLogs={live.clearLogs}
            onAction={(action) => runApplication(route.applicationId, action)}
            onEdit={() => openApplicationForm(selected)}
            onDelete={() => deleteApplication(selected)}
            onAddProcess={() =>
              setDialog({ kind: 'process', applicationId: route.applicationId, process: null })
            }
            onProcessAction={(processId, action) =>
              runProcess(route.applicationId, processId, action)
            }
            onEditProcess={(process) =>
              setDialog({ kind: 'process', applicationId: route.applicationId, process })
            }
            onDeleteProcess={(process) => deleteProcess(route.applicationId, process)}
          />
        )}

        {route.name === 'ports' && (
          <PortsPage
            ports={ports}
            isBusy={(port) => busy.has(`port:${port}`)}
            onRefresh={() => refreshPorts({ force: true })}
            onStopPort={stopPort}
            onProcessAction={runProcess}
          />
        )}

        {route.name === 'settings' && (
          <SettingsPage
            applications={applications}
            isBusy={(applicationId) => busy.has(applicationId)}
            onAutoStart={(applicationId, autoStart) =>
              run(applicationId, () => api.updateApplication(applicationId, { autoStart }))
            }
          />
        )}

        {route.name === 'not-found' && (
          <div className="empty">
            <h2>Page not found</h2>
            <p>That address does not match anything in this dashboard.</p>
            <a href={paths.overview()} className="btn primary">Back to applications</a>
          </div>
        )}
      </main>

      {dialog?.kind === 'application' && (
        <ApplicationForm
          application={dialog.application}
          onSubmit={saveApplication}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'process' && (
        <ProcessForm
          process={dialog.process}
          onSubmit={saveProcess}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
