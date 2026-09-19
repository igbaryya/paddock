/**
 * The shell: a persistent navigation rail, a routed page, and the dialogs that edit configuration.
 *
 * Every action ends the same way — ask the manager, then refetch and let it report what actually
 * happened — so nothing here keeps an optimistic copy of runtime state that could disagree with the
 * processes on the machine.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api.js';
import { buildCommands } from './commands.js';
import { useLiveState } from './useLiveState.js';
import { useFavicons } from './useFavicons.js';
import { Link, navigate, paths, useRoute } from './router.jsx';
import Sidebar from './components/Sidebar.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Icon from './components/Icon.jsx';
import IconButton from './components/IconButton.jsx';
import EmptyState from './components/EmptyState.jsx';
import ApplicationForm from './components/ApplicationForm.jsx';
import ProcessForm from './components/ProcessForm.jsx';
import PostgresForm from './components/PostgresForm.jsx';
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

function isMod(event) {
  return event.metaKey || event.ctrlKey;
}

/** @param {EventTarget|null} target */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export default function App() {
  const route = useRoute();
  const live = useLiveState(route.applicationId ?? null);
  const { applications, selected, logs, connection, reload, ports, refreshPorts } = live;
  // Both the overview and an application's page show the icons, so they are fetched once, here.
  const favicons = useFavicons(applications);
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [staleProcesses, setStaleProcesses] = useState([]);
  const [busy, setBusy] = useState(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIntent, setPaletteIntent] = useState(null);

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

  /**
   * A card was dropped on the canvas. Deliberately not routed through `run`: it locks no controls
   * and needs no refetch — the canvas is already showing the arrangement it just sent, and nothing
   * about what is running has changed. A rejection still has to surface, or the next refresh would
   * quietly undo the move with no explanation.
   */
  const saveLayout = (applicationId, layout) =>
    api.saveLayout(applicationId, layout).catch((err) => setActionError(err.message));

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
    // A new application opens on its own page — it has no processes or server yet, and that is
    // where they get added.
    if (!target && view?.id) navigate(paths.application(view.id));
  };

  /** A saved change can land under a running process, so the view's restart flags are kept first. */
  const closeAfterSave = async (view) => {
    const marked = markedProcessIds(view);
    if (marked.length) setStaleProcesses((ids) => [...new Set([...ids, ...marked])]);
    setDialog(null);
    await reload();
  };

  const saveProcess = async (values) => {
    const { applicationId, process: target } = dialog;
    const view = target
      ? await api.updateProcess(applicationId, target.id, values)
      : await api.addProcess(applicationId, values);
    await closeAfterSave(view);
  };

  const savePostgres = async (postgres) => {
    await closeAfterSave(await api.updateApplication(dialog.application.id, { postgres }));
  };

  const openApplicationForm = (application = null) => setDialog({ kind: 'application', application });

  const commands = useMemo(
    () =>
      buildCommands({
        applications,
        route,
        selected,
        setIntent: setPaletteIntent,
        openApplicationForm,
        refreshPorts,
      }),
    [applications, route, selected, refreshPorts]
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (isMod(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if (paletteOpen || isTypingTarget(event.target)) return;

      if (isMod(event) && event.key >= '1' && event.key <= '9') {
        const index = Number(event.key) - 1;
        const application = applications[index];
        if (!application) return;
        event.preventDefault();
        navigate(paths.application(application.id));
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [applications, paletteOpen]);

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
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <main className="main">
        {route.name === 'overview' && (
          <OverviewPage
            applications={applications}
            favicons={favicons}
            ports={ports}
            busy={busy}
            onCreate={() => openApplicationForm()}
            onAction={runApplication}
          />
        )}

        {route.name === 'application' && (
          <ApplicationPage
            application={selected}
            favicons={favicons}
            /* The list having arrived is what turns "still loading" into "no such application". */
            loaded={applications.length > 0}
            logs={logs}
            busy={busy}
            staleProcesses={staleProcesses}
            intent={paletteIntent}
            onIntentHandled={() => setPaletteIntent(null)}
            onClearLogs={live.clearLogs}
            onAction={(action) => runApplication(route.applicationId, action)}
            onSaveLayout={(layout) => saveLayout(route.applicationId, layout)}
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
            onEditPostgres={() => setDialog({ kind: 'postgres', application: selected })}
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
          <EmptyState
            icon="alert"
            title="Page not found"
            action={<Link to={paths.overview()} className="btn primary">Back to applications</Link>}
          >
            That address does not match anything in this dashboard.
          </EmptyState>
        )}
      </main>

      {/* A notification rather than a banner: it floats over the page instead of pushing it down,
          so a failed click never moves the control that is about to be clicked again. */}
      {banner && (
        <div className="toast" role="alert">
          <Icon name="alert" />
          <p>{banner}</p>
          <IconButton icon="close" label="Dismiss" className="small ghost" onClick={dismissBanner} />
        </div>
      )}

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
      {dialog?.kind === 'postgres' && (
        <PostgresForm
          settings={dialog.application.postgres}
          onSubmit={savePostgres}
          onClose={() => setDialog(null)}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
