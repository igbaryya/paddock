/**
 * The shell: a persistent navigation rail, a routed page, and the dialogs that edit configuration.
 *
 * Every action ends the same way — ask the manager, then refetch and let it report what actually
 * happened — so nothing here keeps an optimistic copy of runtime state that could disagree with the
 * processes on the machine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import { buildCommands } from './commands.js';
import { actionFor, comboFromEvent } from './shortcuts.js';
import { getShortcuts } from './useShortcuts.js';
import { useLiveState } from './useLiveState.js';
import { useFavicons } from './useFavicons.js';
import { useSidebar } from './useSidebar.js';
import { useNotifications } from './useNotifications.js';
import { useDesktopUpdates } from './useDesktopUpdates.js';
import { refreshBranding } from './useBranding.js';
import { ToolbarCornerContext } from './components/Toolbar.jsx';
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
import DashboardPage from './pages/DashboardPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SetupWizard from './components/SetupWizard.jsx';

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
  const sidebar = useSidebar();
  const desktopUpdates = useDesktopUpdates();
  const notifications = useNotifications(applications, desktopUpdates?.state ?? null);
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [staleProcesses, setStaleProcesses] = useState([]);
  const [busy, setBusy] = useState(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIntent, setPaletteIntent] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);

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

  // On every (re)connect, not once: a manager restarted underneath this page may have a new mark,
  // and setup finished from another browser must not open here. A skip is recorded by the manager,
  // so a stream that blips never asks twice.
  useEffect(() => {
    if (connection !== 'live') return;
    refreshBranding();
    api.getSetup().then(
      (setup) => {
        if (setup.needed) setSetupOpen(true);
      },
      () => {}
    );
  }, [connection]);

  const runMcp = (action, body) =>
    run('mcp', async () => {
      if (action === 'start') return api.startMcp();
      if (action === 'stop') return api.stopMcp();
      if (action === 'restart') return api.restartMcp();
      if (action === 'update') return api.updateMcp(body);
      return null;
    });

  const runApplication = async (applicationId, action) => {
    const result = await run(applicationId, () => api.applicationAction(applicationId, action));
    // Only where something was supposed to come up: a process left `crashed` reports `ok: false`,
    // which is the ordinary outcome of stopping it rather than a stop that failed.
    if (action === 'stop') return;
    const summary = failureSummary(result);
    if (summary) setActionError(summary);
  };

  /** Finished or skipped, setup ends the same way. Not through `run`: its toast sits under the wizard. */
  const finishSetup = async () => {
    await api.completeSetup();
    setSetupOpen(false);
  };

  /**
   * The wizard's first application: the application and its one process, as one step. A process the
   * manager refuses takes the new application with it, so the corrected retry is not then refused
   * for a name the empty leftover still holds.
   */
  const createFirstApplication = async ({ name, repositoryPath, command }, start) => {
    const created = await api.createApplication({ name, kind: 'processes' });
    try {
      await api.addProcess(created.id, { name, repositoryPath, command });
    } catch (err) {
      await api.deleteApplication(created.id).catch(() => {});
      throw err;
    }
    // Best effort: the application now exists, and that alone keeps setup from opening again.
    await api.completeSetup().catch(() => {});
    setSetupOpen(false);
    await reload();
    navigate(paths.application(created.id));
    if (start) runApplication(created.id, 'start');
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

  // Settings is a page of its own, without the rail; leaving it goes back to wherever it was opened.
  const inSettings = route.name === 'settings';
  const settingsReturnRef = useRef(paths.dashboard());
  if (!inSettings) settingsReturnRef.current = window.location.pathname;
  const closeSettings = () => navigate(settingsReturnRef.current);

  // The open application, for the shortcuts that act on it; anywhere else they leave the key alone.
  const current = route.name === 'application' && selected ? selected : null;
  const shortcutActions = {
    newApplication: () => openApplicationForm(),
    toggleSidebar: !inSettings && (() => sidebar.toggle()),
    showShortcuts: () => navigate(paths.settings('shortcuts')),
    goDashboard: () => navigate(paths.dashboard()),
    goOverview: () => navigate(paths.overview()),
    goPorts: () => navigate(paths.ports()),
    goSettings: () => navigate(paths.settings()),
    editApplication: current && (() => openApplicationForm(current)),
    openLogs: current && (() => setPaletteIntent({ kind: 'logs', applicationId: current.id })),
    openTerminal: current && (() => setPaletteIntent({ kind: 'terminal', applicationId: current.id })),
    ...Object.fromEntries(
      ['start', 'stop', 'restart'].map((action) => [
        `${action}Application`,
        current && !busy.has(current.id) && (() => runApplication(current.id, action)),
      ])
    ),
  };

  // Read on each press, so the listener is bound once rather than on every render.
  const onKeyDownRef = useRef(null);
  onKeyDownRef.current = (event) => {
    const { bindings, recording } = getShortcuts();
    if (recording || event.repeat) return;
    const blocked = paletteOpen || dialog || setupOpen || isTypingTarget(event.target);

    // Whatever is on top of Settings — the palette, a dialog — takes Escape instead.
    if (inSettings && event.key === 'Escape' && !blocked) {
      closeSettings();
      return;
    }

    const combo = comboFromEvent(event);
    if (!combo) return;
    const action = actionFor(bindings, combo);

    // The palette's own shortcut works from anywhere, a text field included: it is how you leave one.
    if (action === 'palette') {
      event.preventDefault();
      setPaletteOpen((open) => !open);
      return;
    }

    if (blocked) return;

    if (isMod(event) && !event.altKey && !event.shiftKey && event.key >= '1' && event.key <= '9') {
      const application = applications[Number(event.key) - 1];
      if (!application) return;
      event.preventDefault();
      navigate(paths.application(application.id));
      return;
    }

    const handler = action && shortcutActions[action];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  useEffect(() => {
    const onKeyDown = (event) => onKeyDownRef.current(event);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const banner = actionError ?? live.error;
  const dismissBanner = () => {
    setActionError(null);
    live.dismissError();
  };

  return (
    <div className={`app${inSettings ? ' no-sidebar' : ''}`}>
      {!inSettings && (
        <Sidebar
          applications={applications}
          route={route}
          connection={connection}
          portCount={ports.ports?.length ?? null}
          system={live.system}
          network={live.network}
          onOpenPalette={() => setPaletteOpen(true)}
          collapsed={sidebar.collapsed}
          onToggleCollapsed={sidebar.toggle}
        />
      )}

      <ToolbarCornerContext.Provider value={notifications}>
      <main className="main">
        {route.name === 'dashboard' && (
          <DashboardPage
            applications={applications}
            loaded={live.loaded}
            unreachable={Boolean(live.error)}
            ports={ports}
            system={live.system}
            network={live.network}
            agents={live.mcp}
            problems={notifications.items}
            onRetry={() => reload()}
            onCreate={() => openApplicationForm()}
          />
        )}

        {route.name === 'overview' && (
          <OverviewPage
            applications={applications}
            loaded={live.loaded}
            unreachable={Boolean(live.error)}
            favicons={favicons}
            ports={ports}
            busy={busy}
            onRetry={() => reload()}
            onCreate={() => openApplicationForm()}
            onAction={runApplication}
            onProcessAction={runProcess}
            onEdit={openApplicationForm}
            onEditProcess={(application, process) =>
              application.kind === 'postgres'
                ? setDialog({ kind: 'postgres', application })
                : setDialog({ kind: 'process', applicationId: application.id, process })
            }
          />
        )}

        {route.name === 'application' && (
          <ApplicationPage
            application={selected}
            favicons={favicons}
            /* The list having arrived is what turns "still loading" into "no such application". */
            loaded={live.loaded}
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
            network={live.network}
            isBusy={(port) => busy.has(`port:${port}`)}
            onRefresh={() => {
              refreshPorts({ force: true });
              live.refreshNetwork({ force: true });
            }}
            onStopPort={stopPort}
            onProcessAction={runProcess}
          />
        )}

        {route.name === 'settings' && (
          <SettingsPage
            tab={route.tab}
            returnTo={settingsReturnRef.current}
            mcp={{ busy: busy.has('mcp'), live: live.mcp, onAction: runMcp }}
            applications={applications}
            isBusy={(applicationId) => busy.has(applicationId)}
            onAutoStart={(applicationId, autoStart) =>
              run(applicationId, () => api.updateApplication(applicationId, { autoStart }))
            }
            onRunSetup={() => setSetupOpen(true)}
          />
        )}

        {route.name === 'not-found' && (
          <EmptyState
            icon="alert"
            title="Page not found"
            action={<Link to={paths.dashboard()} className="btn primary">Back to the dashboard</Link>}
          >
            That address does not match anything in this dashboard.
          </EmptyState>
        )}
      </main>
      </ToolbarCornerContext.Provider>

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
        actionContext={{ applications, runApplication, runProcess, setIntent: setPaletteIntent }}
        onClose={() => setPaletteOpen(false)}
      />

      {setupOpen && <SetupWizard onFinish={finishSetup} onCreateApplication={createFirstApplication} />}
    </div>
  );
}
