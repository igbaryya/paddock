/**
 * An application as a canvas: the application on the left, what it runs in columns beside it, curves
 * showing what calls what, and a drawer over the right for whichever card is selected.
 *
 * This file is the translation between the application view and the canvas — which cards exist,
 * which of them connect, and where each one sits. The surface itself knows none of that, and the
 * cards know nothing about layout.
 *
 * The arrows come from the view's `links`: connections a port scan saw a process holding open to a
 * local port. A link to a sibling is an arrow between two process cards; a link to anything else —
 * another application's process, a database Paddock does not run — gets a card of its own, at the
 * far right. The application card connects only to the processes nothing else was seen calling,
 * so with no links at all it fans out to every process, as it always did.
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
  ServiceNode,
} from './CanvasNodes.jsx';
import { navigate, paths } from '../router.jsx';
import { useSecondsTick } from '../useSecondsTick.js';

/**
 * The canvas's own cards. The `@` is what keeps them clear of the process ids they sit beside: a
 * generated process id is `proc_…` and a PostgreSQL server's is `postgres`, so neither can collide.
 */
const ROOT = '@application';
const CONNECTION = '@connection';
const PLACEHOLDER = '@placeholder';
const SERVICE = '@service:';

/** Auto-layout geometry: a column step wide enough to leave a card's width plus room for a curve. */
const COLUMN_X = 372;
const ROW_Y = 156;
/** Processes run down a column and start a new one past this, so a long list stays on one screen. */
const COLUMN_ROWS = 4;

/**
 * One card per process of another application, whatever ports it was reached on; one per port for
 * anything Paddock does not run, since all that is known about it is the port and an OS name.
 */
const serviceId = ({ target, port }) =>
  target.kind === 'managed' ? `${SERVICE}${target.applicationId}/${target.processId}` : `${SERVICE}${port}`;

/**
 * The links as the canvas draws them: arrows between sibling processes, and cards for whatever
 * outside the application they reach.
 * @param {object} application an ApplicationView
 */
function graphOf(application) {
  const ids = new Set(application.processes.map((process) => process.id));
  const calls = new Map();
  const services = new Map();
  for (const link of application.links ?? []) {
    const { target } = link;
    const sibling = target.kind === 'managed' && target.applicationId === application.id && ids.has(target.processId);
    const to = sibling ? target.processId : serviceId(link);
    if (!sibling) {
      if (!services.has(to)) services.set(to, { id: to, target, ports: [] });
      const service = services.get(to);
      if (!service.ports.includes(link.port)) service.ports.push(link.port);
    }
    calls.set(`${link.from}->${to}`, { from: link.from, to });
  }
  for (const service of services.values()) service.ports.sort((a, b) => a - b);
  return { calls: [...calls.values()], services: [...services.values()] };
}

/**
 * The processes the application card points at: those nothing was seen calling. A cycle that
 * nothing outside it calls into would then hang off nothing, so one member of each such cycle is
 * added as well.
 */
function entryPoints(processes, calls) {
  const next = new Map();
  for (const { from, to } of calls) {
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  }
  const called = new Set(calls.map((call) => call.to));
  const reached = new Set();
  const walk = (id) => {
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      if (reached.has(current)) continue;
      reached.add(current);
      queue.push(...(next.get(current) ?? []));
    }
  };
  const roots = processes.filter((process) => !called.has(process.id)).map((process) => process.id);
  roots.forEach(walk);
  for (const process of processes) {
    if (reached.has(process.id)) continue;
    roots.push(process.id);
    walk(process.id);
  }
  return roots;
}

/**
 * How many calls deep each process sits, so a callee lands to the right of everything calling it.
 * Bounded by the process count, which is what stops a cycle relaxing forever.
 */
function depthsOf(processes, calls) {
  const depth = new Map(processes.map((process) => [process.id, 0]));
  for (let pass = 0; pass < processes.length; pass += 1) {
    let moved = false;
    for (const { from, to } of calls) {
      if (!depth.has(from) || !depth.has(to)) continue;
      const deeper = depth.get(from) + 1;
      if (deeper > depth.get(to) && deeper < processes.length) {
        depth.set(to, deeper);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

/**
 * Where each card sits when nobody has moved it: the application first, then what it runs in
 * columns to its right — one group of columns per call depth, in configured order within each. A
 * card outside the application sits one column past its deepest caller, below that column's
 * processes, so an arrow to it never has to cross a card to get there.
 * @param {object} application an ApplicationView
 * @param {{calls: object[], services: object[]}} graph
 */
function autoLayout(application, graph) {
  const { processes } = application;
  const depth = depthsOf(processes, graph.calls);
  const groups = [];
  for (const process of processes) {
    const level = depth.get(process.id);
    (groups[level] ??= []).push(process.id);
  }
  for (const service of graph.services) {
    const callers = graph.calls.filter((call) => call.to === service.id && depth.has(call.from));
    const level = Math.max(0, ...callers.map((call) => depth.get(call.from) + 1));
    (groups[level] ??= []).push(service.id);
  }
  const ordered = groups.filter(Boolean);

  const positions = {};
  let column = 0;
  let firstRows = 0;
  for (const group of ordered) {
    group.forEach((id, index) => {
      positions[id] = {
        x: COLUMN_X * (1 + column + Math.floor(index / COLUMN_ROWS)),
        y: ROW_Y * (index % COLUMN_ROWS),
      };
    });
    if (column === 0) firstRows = Math.min(group.length, COLUMN_ROWS);
    column += Math.ceil(group.length / COLUMN_ROWS);
  }
  // Centred on the column beside it, so the curves fan out evenly rather than all bending down.
  positions[ROOT] = { x: 0, y: Math.round((Math.max(firstRows, 1) - 1) * ROW_Y / 2) };
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

  const graph = graphOf(application);
  const placement = { ...autoLayout(application, graph), ...moved };
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
    ...graph.services.map((service) => ({
      id: service.id,
      ...at(service.id),
      render: ({ selected }) => (
        <ServiceNode
          service={service}
          selected={selected}
          // Another application's process opens that application; anything else has nowhere to go.
          onOpen={
            service.target.kind === 'managed'
              ? () => navigate(paths.application(service.target.applicationId))
              : () => setSelection({ kind: 'service', id: service.id })
          }
        />
      ),
    })),
    ...(placeholder
      ? [{ id: PLACEHOLDER, ...at(PLACEHOLDER), render: () => <PlaceholderNode {...placeholder} /> }]
      : []),
  ];

  const edges = [
    ...entryPoints(application.processes, graph.calls).map((id) => ({ from: ROOT, to: id })),
    ...graph.calls.map((call) => ({ ...call, arrow: true })),
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

  /** Back to the auto-layout, which is the only way a canvas arranged before its links were known
   *  gets them laid out left to right. */
  const onArrange = () => {
    setMoved({});
    onSaveLayout({});
  };

  /**
   * Which card was clicked decides what the drawer shows; the placeholder opens a form instead. A
   * card outside the application has no drawer — selecting it only lights up what reaches it.
   */
  const onSelect = (id) => {
    if (id === ROOT) return setSelection({ kind: 'application', id });
    if (id === CONNECTION) return setSelection({ kind: 'connection', id });
    if (id?.startsWith(SERVICE)) return setSelection({ kind: 'service', id });
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
        onArrange={Object.keys(moved).length ? onArrange : undefined}
        label={`${application.name} services`}
      />

      {selection && selection.kind !== 'service' && (
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
