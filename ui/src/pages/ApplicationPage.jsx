/**
 * One application in full: a top bar that acts on the whole of it, and below that the canvas its
 * services sit on, with the drawer that details whichever one is selected.
 *
 * The page itself no longer stacks anything. A process's own tail and the SQL console stay one
 * click away inside the drawer; every process at once is the logger on the top bar, which takes
 * the window so a long trace is actually readable.
 *
 * `application` is null both before the first fetch and when the id in the URL does not exist, and
 * those are different situations — a link someone saved after deleting the application should say
 * so rather than spinning forever.
 */
import { useState, useEffect } from 'react';
import ApplicationHeader from '../components/ApplicationHeader.jsx';
import ApplicationCanvas from '../components/ApplicationCanvas.jsx';
import EmptyState from '../components/EmptyState.jsx';
import LogViewer from '../components/LogViewer.jsx';
import Modal from '../components/Modal.jsx';
import TerminalDrawer from '../components/TerminalDrawer.jsx';
import TerminalPanel from '../components/TerminalPanel.jsx';
import { Link, paths } from '../router.jsx';

/**
 * @param {{application: object|null, favicons: Record<string, object>, loaded: boolean,
 *          logs: object[], busy: Set<string>, staleProcesses: string[], onClearLogs: () => void,
 *          onAction: Function, onSaveLayout: Function, onEdit: Function, onDelete: Function,
 *          onAddProcess: Function, onProcessAction: Function, onEditProcess: Function,
 *          onDeleteProcess: Function, onEditPostgres: Function,
 *          intent?: object|null, onIntentHandled?: () => void}} props
 */
export default function ApplicationPage({
  application,
  favicons,
  loaded,
  logs,
  busy,
  staleProcesses,
  intent,
  onIntentHandled,
  onClearLogs,
  onAction,
  onSaveLayout,
  onEdit,
  onDelete,
  onAddProcess,
  onProcessAction,
  onEditProcess,
  onDeleteProcess,
  onEditPostgres,
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** @type {[{kind: 'session', sessionId: string}|{kind: 'new', processId: string}|null, Function]} */
  const [terminalRequest, setTerminalRequest] = useState(null);
  const [drawerIntent, setDrawerIntent] = useState(null);
  // Both belong to this application: the tail would show the wrong processes' names over the new
  // application's lines, and the terminal panel would be listing another application's shells.
  // Closing the panel does not close those shells — they keep running on the manager.
  useEffect(() => {
    setLogsOpen(false);
    setTerminalOpen(false);
    setTerminalRequest(null);
    setDrawerIntent(null);
  }, [application?.id]);

  useEffect(() => {
    if (!application || !intent || intent.applicationId !== application.id) return;
    if (intent.kind === 'logs') setLogsOpen(true);
    if (intent.kind === 'terminal') {
      setTerminalOpen(true);
      if (intent.sessionId) setTerminalRequest({ kind: 'session', sessionId: intent.sessionId });
      else if (intent.processId) setTerminalRequest({ kind: 'new', processId: intent.processId });
    }
    if (intent.kind === 'drawer' && intent.processId) {
      setDrawerIntent({ kind: 'process', processId: intent.processId });
    }
    onIntentHandled?.();
  }, [application, intent, onIntentHandled]);

  if (!application) {
    return loaded ? (
      <EmptyState
        icon="alert"
        title="No such application"
        action={<Link to={paths.overview()} className="btn primary">Back to applications</Link>}
      >
        It may have been deleted, or the link may be out of date.
      </EmptyState>
    ) : (
      <p className="empty-inline">Loading…</p>
    );
  }

  return (
    <>
      <ApplicationHeader
        application={application}
        favicons={favicons}
        busy={busy.has(application.id)}
        onAction={onAction}
        onEdit={onEdit}
        onAddProcess={onAddProcess}
        onOpenLogs={() => setLogsOpen(true)}
        onTerminalChoose={(choice) => {
          setTerminalRequest(choice);
          setTerminalOpen(true);
        }}
      />

      {/* Keyed by application: the canvas holds the arrangement and the selection, and both belong
          to one application — carrying either across a switch would show the wrong thing. */}
      <div className="app-workspace">
        <ApplicationCanvas
          key={application.id}
          application={application}
          favicons={favicons}
          logs={logs}
          busy={busy}
          staleProcesses={staleProcesses}
          drawerIntent={drawerIntent}
          onDrawerIntentHandled={() => setDrawerIntent(null)}
          onSaveLayout={onSaveLayout}
          onClearLogs={onClearLogs}
          onEdit={onEdit}
          onDelete={onDelete}
          onAddProcess={onAddProcess}
          onProcessAction={onProcessAction}
          onEditProcess={onEditProcess}
          onDeleteProcess={onDeleteProcess}
          onEditPostgres={onEditPostgres}
        />

        {terminalOpen && (
          <TerminalDrawer onClose={() => setTerminalOpen(false)}>
            <TerminalPanel
              application={application}
              logs={logs}
              onClearLogs={onClearLogs}
              request={terminalRequest}
              onRequestHandled={() => setTerminalRequest(null)}
              onClose={() => setTerminalOpen(false)}
            />
          </TerminalDrawer>
        )}
      </div>

      {logsOpen && (
        <Modal title={`${application.name} logs`} size="full" onClose={() => setLogsOpen(false)}>
          <LogViewer application={application} logs={logs} onClear={onClearLogs} />
        </Modal>
      )}
    </>
  );
}
