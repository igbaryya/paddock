/**
 * An application as a canvas: the application on the left, what it runs in columns beside it, curves
 * showing what belongs to what, and a drawer over the right for whichever card is selected.
 *
 * This file is the translation between the application view and the canvas — which cards exist,
 * which of them connect, and where each one sits. The surface itself knows none of that, and the
 * cards know nothing about layout.
 *
 * Positions are the user's and are kept on the manager, so an arrangement survives a refresh and
 * the next launch. Until someone moves a card it has no stored position and `autoLayout` places it,
 * which is why an application that has never been arranged still opens the same way every time.
 * The first drag stores the whole arrangement, including the cards nobody touched: what was on
 * screen is what gets remembered.
 */
import { useEffect, useState } from 'react';
import Canvas from './Canvas.jsx';
import NodeDetails from './NodeDetails.jsx';
import {
  ApplicationNode,
  ConnectionNode,
  PlaceholderNode,
  ProcessNode,
} from './CanvasNodes.jsx';
import { useSecondsTick } from '../useSecondsTick.js';

/**
 * The canvas's own cards. The `@` is what keeps them clear of the process ids they sit beside: a
 * generated process id is `proc_…` and a PostgreSQL server's is `postgres`, so neither can collide.
 */
const ROOT = '@application';
const CONNECTION = '@connection';
const PLACEHOLDER = '@placeholder';

/** Auto-layout geometry: a column step wide enough to leave a card's width plus room for a curve. */
const COLUMN_X = 372;
const ROW_Y = 156;
/** Processes run down a column and start a new one past this, so a long list stays on one screen. */
const COLUMN_ROWS = 4;

/**
 * Where each card sits when nobody has moved it: the application first, then what it runs in
 * columns to its right, in configured order — which for processes is also start order.
 * @param {object} application an ApplicationView
 */
function autoLayout(application) {
  const { processes } = application;
  const rows = Math.min(processes.length, COLUMN_ROWS);
  const positions = {
    // Centred on the column beside it, so the curves fan out evenly rather than all bending down.
    [ROOT]: { x: 0, y: Math.round((Math.max(rows, 1) - 1) * ROW_Y / 2) },
  };
  processes.forEach((process, index) => {
    positions[process.id] = {
      x: COLUMN_X * (1 + Math.floor(index / COLUMN_ROWS)),
      y: ROW_Y * (index % COLUMN_ROWS),
    };
  });
  // A defined server has exactly one process, so its connection card goes one column further out.
  positions[CONNECTION] = { x: COLUMN_X * 2, y: 0 };
  positions[PLACEHOLDER] = { x: COLUMN_X, y: 0 };
  return positions;
}

/**
 * @param {{application: object, favicons: Record<string, object>, logs: object[],
 *          busy: Set<string>, staleProcesses: string[], onSaveLayout: (layout: object) => void,
 *          onClearLogs: () => void, onEdit: () => void, onDelete: () => void,
 *          onAddProcess: () => void,
 *          onProcessAction: (processId: string, action: string) => void,
 *          drawerIntent?: object|null, onDrawerIntentHandled?: () => void,
 *          onEditProcess: (process: object) => void,
 *          onDeleteProcess: (process: object) => void, onEditPostgres: () => void}} props
 */
export default function ApplicationCanvas({
  application,
  favicons,
  logs,
  busy,
  staleProcesses,
  drawerIntent,
  onDrawerIntentHandled,
  onSaveLayout,
  onClearLogs,
  onEdit,
  onDelete,
  onAddProcess,
  onProcessAction,
  onEditProcess,
  onDeleteProcess,
  onEditPostgres,
}) {
  // One clock for every card that counts elapsed time, rather than an interval per card.
  const now = useSecondsTick();
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    if (!drawerIntent?.processId) return;
    setSelection({ kind: 'process', id: drawerIntent.processId });
    onDrawerIntentHandled?.();
  }, [drawerIntent]); // onDrawerIntentHandled is intentionally omitted — it only clears this intent once.
  /** The arrangement on screen. Seeded from the manager — this component is remounted per
   *  application — and authoritative from then on, so a drop never fights the next status refetch. */
  const [moved, setMoved] = useState(() => application.layout ?? {});

  const postgres = application.kind === 'postgres';
  const server = postgres ? application.processes[0] ?? null : null;
  // A PostgreSQL application before its server is defined, or a process application with nothing in
  // it yet: either way there is one thing to do, and it gets a card saying so.
  const placeholder = postgres && !application.postgres
    ? {
        image: '/postgres.svg',
        title: 'Define PostgreSQL',
        hint: 'Point this application at a cluster on this machine.',
        onClick: onEditPostgres,
      }
    : !postgres && application.processes.length === 0
      ? {
          title: 'Add the first process',
          hint: 'A repository path, and the command that starts it there.',
          onClick: onAddProcess,
        }
      : null;

  const placement = { ...autoLayout(application), ...moved };
  const at = (id) => placement[id] ?? { x: 0, y: 0 };

  const nodes = [
    {
      id: ROOT,
      ...at(ROOT),
      render: ({ selected }) => (
        <ApplicationNode
          application={application}
          favicons={favicons}
          selected={selected}
          onOpen={() => setSelection({ kind: 'application', id: ROOT })}
        />
      ),
    },
    ...application.processes.map((process) => ({
      id: process.id,
      ...at(process.id),
      render: ({ selected }) => (
        <ProcessNode
          process={process}
          favicon={favicons[process.id]?.dataUrl}
          now={now}
          busy={busy.has(process.id)}
          stale={staleProcesses.includes(process.id)}
          selected={selected}
          onAction={(action) => onProcessAction(process.id, action)}
          onOpen={() => setSelection({ kind: 'process', id: process.id })}
        />
      ),
    })),
    ...(application.postgres
      ? [
          {
            id: CONNECTION,
            ...at(CONNECTION),
            render: ({ selected }) => (
              <ConnectionNode
                settings={application.postgres}
                selected={selected}
                onOpen={() => setSelection({ kind: 'connection', id: CONNECTION })}
              />
            ),
          },
        ]
      : []),
    ...(placeholder
      ? [{ id: PLACEHOLDER, ...at(PLACEHOLDER), render: () => <PlaceholderNode {...placeholder} /> }]
      : []),
  ];

  const edges = [
    ...application.processes.map((process) => ({ from: ROOT, to: process.id })),
    ...(placeholder ? [{ from: ROOT, to: PLACEHOLDER }] : []),
    // The connection hangs off the server it connects to, not off the application.
    ...(application.postgres && server ? [{ from: server.id, to: CONNECTION }] : []),
  ];

  /**
   * A dropped card. The whole arrangement goes to the manager, and only for the cards on screen:
   * it stores exactly what is being shown, so a deleted process stops being remembered.
   */
  const onMove = (id, position) => {
    // Built from the cards themselves rather than from the stored positions, so every entry is a
    // position something on screen actually has — and a card that has never been moved is stored
    // where the auto-layout put it instead of being left to drift if that layout ever changes.
    const kept = Object.fromEntries(
      nodes.map((node) => [node.id, node.id === id ? position : { x: node.x, y: node.y }])
    );
    setMoved(kept);
    onSaveLayout(kept);
  };

  /** Which card was clicked decides what the drawer shows; the placeholder opens a form instead. */
  const onSelect = (id) => {
    if (id === ROOT) return setSelection({ kind: 'application', id });
    if (id === CONNECTION) return setSelection({ kind: 'connection', id });
    if (id && id !== PLACEHOLDER) return setSelection({ kind: 'process', id });
    setSelection(null);
  };

  return (
    <div className="canvas-page">
      <Canvas
        nodes={nodes}
        edges={edges}
        selectedId={selection?.id ?? null}
        onSelect={onSelect}
        onMove={onMove}
        label={`${application.name} services`}
      />

      {selection && (
        // Keyed by the card: the tabs belong to the thing being looked at, and carrying "Output"
        // across a switch to a card that has none would leave the drawer blank.
        <NodeDetails
          key={selection.id}
          application={application}
          selection={selection}
          logs={logs}
          now={now}
          staleProcesses={staleProcesses}
          onClose={() => setSelection(null)}
          onClearLogs={onClearLogs}
          onProcessAction={onProcessAction}
          onEdit={onEdit}
          onDelete={onDelete}
          onAddProcess={onAddProcess}
          onEditProcess={onEditProcess}
          onDeleteProcess={onDeleteProcess}
          onEditPostgres={onEditPostgres}
        />
      )}
    </div>
  );
}
