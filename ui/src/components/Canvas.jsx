/**
 * A pannable, zoomable surface with cards on it and curves between them.
 *
 * Everything to do with the two coordinate systems lives in this one file: the viewport is in screen
 * pixels, the world the cards sit in is in canvas units, and `view` is the transform between them.
 * A drag divided by the wrong scale is the classic bug in a canvas, so there is exactly one place
 * that converts — `worldAt` — and every gesture goes through it.
 *
 * It is deliberately not a graph library. The surface is a transform, a pointer handler and an SVG
 * layer; what the cards are, which of them connect, and where a moved card is stored are all the
 * caller's business.
 *
 * Gestures follow what a canvas has already taught everyone: pinch or ⌘/Ctrl+wheel zooms toward the
 * pointer, a plain wheel or a two-finger scroll pans, dragging the ground pans, dragging a card
 * moves it, and a press that never moved is a click that selects.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.8;
/** Wheel deltas are in device-dependent units; this turns one into a sane zoom factor. */
const ZOOM_PER_DELTA = 0.0022;
const ZOOM_STEP = 1.25;
/** Below this a press is a click, not a drag: a pointer never holds perfectly still. */
const DRAG_SLOP_PX = 4;
/** Room left around the cards when the view is fitted to them. */
const FIT_PADDING_PX = 72;
/**
 * Where a card's curves meet it: the middle of its header strip, in world units down from its
 * origin — so it is half of the `.node-head` height the stylesheet fixes. Anchoring to the header
 * rather than to the middle of the card is what lets cards differ in height without their curves
 * drifting off the thing they point at.
 */
const ANCHOR_Y = 22;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A curve from one card's right edge to the next card's left edge, flattening as the two line up —
 * the horizontal S every service graph draws.
 */
function edgePath(from, to, width) {
  const x1 = from.x + width;
  const y1 = from.y + ANCHOR_Y;
  const x2 = to.x;
  const y2 = to.y + ANCHOR_Y;
  const bend = Math.max(36, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/**
 * What a gesture must not start on. A card carries its own controls, and pressing Stop is not the
 * beginning of a drag.
 *
 * The exception is a card's own title: it is a button so the keyboard can open the card, but it is
 * also the obvious place to grab a card with a pointer, so it is marked as a handle and a press on
 * it starts a gesture like any other part of the card.
 */
const isControl = (target) => {
  const control = target.closest('button, a, input, textarea, select, [role="tab"]');
  return control !== null && !control.hasAttribute('data-drag-handle');
};

/**
 * The two lengths the maths and the stylesheet both have to agree on, read from the tokens so there
 * is still only one definition of each.
 */
function readMetrics(element) {
  const style = getComputedStyle(element);
  const read = (name, fallback) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
  return { nodeWidth: read('--node-width', 272), dot: read('--canvas-dot-size', 22) };
}

/**
 * @param {{nodes: {id: string, x: number, y: number, render: (state: {selected: boolean}) =>
 *            import('react').ReactNode}[],
 *          edges?: {from: string, to: string}[], selectedId?: string|null,
 *          onSelect?: (id: string|null) => void,
 *          onMove?: (id: string, position: {x: number, y: number}) => void,
 *          label: string}} props
 *   `onMove` is called once, on the drop — not for every frame of the drag, which is what would
 *   turn one gesture into a request per pixel.
 */
export default function Canvas({ nodes, edges = [], selectedId = null, onSelect, onMove, label }) {
  const viewportRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  /** The card being dragged and where the pointer has it, so only the drop commits anything. */
  const [drag, setDrag] = useState(null);
  const [panning, setPanning] = useState(false);
  const [metrics, setMetrics] = useState({ nodeWidth: 272, dot: 22 });
  /** Read by handlers that are registered once and must not close over a stale transform. */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The gesture in flight. A ref, so a pointer event never reads a position a render behind. */
  const gestureRef = useRef(null);
  const fittedRef = useRef(false);

  /** Screen point to world point. The only conversion between the two systems. */
  const worldAt = useCallback((clientX, clientY) => {
    const rect = viewportRef.current.getBoundingClientRect();
    const { x, y, scale } = viewRef.current;
    return { x: (clientX - rect.left - x) / scale, y: (clientY - rect.top - y) / scale };
  }, []);

  /** Zoom while holding one point still: the one under the pointer, or the middle of the view. */
  const zoomAround = useCallback((factor, clientX, clientY) => {
    const rect = viewportRef.current.getBoundingClientRect();
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    setView((current) => {
      const scale = clamp(current.scale * factor, ZOOM_MIN, ZOOM_MAX);
      const ratio = scale / current.scale;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, []);

  /**
   * Centre every card in the viewport at a scale that fits them, never magnifying past life size.
   * The box is measured off the cards themselves rather than assumed: they size to their content,
   * so only the DOM knows how tall a card with three ports and an error on it ended up.
   */
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const slots = [...viewport.querySelectorAll('[data-node-id]')];
    if (slots.length === 0) return;
    const placed = new Map(nodes.map((node) => [node.id, node]));
    const boxes = slots
      .map((slot) => ({ node: placed.get(slot.dataset.nodeId), slot }))
      .filter(({ node }) => node);
    const left = Math.min(...boxes.map(({ node }) => node.x));
    const top = Math.min(...boxes.map(({ node }) => node.y));
    const right = Math.max(...boxes.map(({ node, slot }) => node.x + slot.offsetWidth));
    const bottom = Math.max(...boxes.map(({ node, slot }) => node.y + slot.offsetHeight));
    const width = right - left;
    const height = bottom - top;
    const box = viewport.getBoundingClientRect();
    const scale = clamp(
      Math.min((box.width - FIT_PADDING_PX * 2) / width, (box.height - FIT_PADDING_PX * 2) / height),
      ZOOM_MIN,
      1
    );
    setView({
      scale,
      x: (box.width - width * scale) / 2 - left * scale,
      y: (box.height - height * scale) / 2 - top * scale,
    });
  }, [nodes]);

  useLayoutEffect(() => {
    setMetrics(readMetrics(viewportRef.current));
  }, []);

  // Fitted once, on the way in: the canvas opens showing everything the application has. After that
  // the view is the user's, and a card being added must not throw away where they had panned to.
  useLayoutEffect(() => {
    if (fittedRef.current || nodes.length === 0) return;
    fittedRef.current = true;
    fit();
  }, [nodes, fit]);

  // Registered by hand rather than with onWheel: React listens for wheel passively, and a passive
  // listener cannot preventDefault — which is what stops ⌘+wheel zooming the whole page instead.
  useEffect(() => {
    const viewport = viewportRef.current;
    const onWheel = (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAround(Math.exp(-event.deltaY * ZOOM_PER_DELTA), event.clientX, event.clientY);
        return;
      }
      setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  const onPointerDown = (event) => {
    if (event.button !== 0 || isControl(event.target)) return;
    const slot = event.target.closest('[data-node-id]');
    const node = slot ? nodes.find((one) => one.id === slot.dataset.nodeId) : null;
    // A slot whose node has just gone is a render caught mid-flight: taking the pointer here would
    // strand the capture on a gesture that can never be completed.
    if (slot && !node) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (node) {
      const point = worldAt(event.clientX, event.clientY);
      gestureRef.current = {
        kind: 'node',
        id: node.id,
        // The grab point inside the card, so it does not jump to sit under the cursor.
        grabX: point.x - node.x,
        grabY: point.y - node.y,
        startX: node.x,
        startY: node.y,
        // Updated on every move, so the drop commits where the card actually is and never a
        // position one render behind.
        x: node.x,
        y: node.y,
        moved: false,
      };
      setDrag({ id: node.id, x: node.x, y: node.y });
      return;
    }

    gestureRef.current = {
      kind: 'pan',
      originX: event.clientX,
      originY: event.clientY,
      viewX: view.x,
      viewY: view.y,
      moved: false,
    };
    setPanning(true);
  };

  const onPointerMove = (event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === 'pan') {
      const dx = event.clientX - gesture.originX;
      const dy = event.clientY - gesture.originY;
      if (Math.hypot(dx, dy) > DRAG_SLOP_PX) gesture.moved = true;
      setView((current) => ({ ...current, x: gesture.viewX + dx, y: gesture.viewY + dy }));
      return;
    }

    const point = worldAt(event.clientX, event.clientY);
    gesture.x = point.x - gesture.grabX;
    gesture.y = point.y - gesture.grabY;
    // Measured from where the press started, so a slow drag past the threshold still counts.
    if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > DRAG_SLOP_PX) {
      gesture.moved = true;
    }
    setDrag({ id: gesture.id, x: gesture.x, y: gesture.y });
  };

  const onPointerUp = (event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setPanning(false);
    setDrag(null);
    // A press on a card's own controls started no gesture and took no capture, and this same handler
    // still sees its bubbling pointerup — so there is nothing to release and nothing to commit.
    if (!gesture) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A press that never moved is a click: on a card it selects it, on the ground it clears the
    // selection. Only a press that actually travelled is a move worth storing.
    if (!gesture.moved) {
      onSelect?.(gesture.kind === 'node' ? gesture.id : null);
      return;
    }
    if (gesture.kind === 'node') {
      onMove?.(gesture.id, { x: Math.round(gesture.x), y: Math.round(gesture.y) });
    }
  };

  /** The dragged card's live position wins over the stored one, which catches up on the drop. */
  const positionOf = (node) => (drag?.id === node.id ? drag : node);
  const placed = new Map(nodes.map((node) => [node.id, positionOf(node)]));

  return (
    <div className="canvas" role="group" aria-label={label}>
      <div
        ref={viewportRef}
        className={`canvas-viewport${panning ? ' panning' : ''}`}
        style={{
          backgroundSize: `${metrics.dot * view.scale}px ${metrics.dot * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {/* Under the cards and out of the pointer's way. It overflows its own box on purpose: the
              box is a point at the world's origin, and the curves are drawn in world coordinates. */}
          <svg className="canvas-edges" aria-hidden="true">
            {edges.map(({ from, to }) => {
              const a = placed.get(from);
              const b = placed.get(to);
              if (!a || !b) return null;
              const live = selectedId === from || selectedId === to;
              return (
                <path
                  key={`${from}->${to}`}
                  className={`canvas-edge${live ? ' live' : ''}`}
                  d={edgePath(a, b, metrics.nodeWidth)}
                  // Zoom must not thicken the curves, or a zoomed-in canvas turns into ribbons.
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>

          {nodes.map((node) => {
            const position = positionOf(node);
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                className={`canvas-slot${drag?.id === node.id ? ' dragging' : ''}`}
                style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
              >
                {node.render({ selected: selectedId === node.id })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="canvas-controls">
        <IconButton
          icon="minus"
          label="Zoom out"
          className="small"
          disabled={view.scale <= ZOOM_MIN}
          onClick={() => zoomAround(1 / ZOOM_STEP)}
        />
        <span className="canvas-zoom meta">{Math.round(view.scale * 100)}%</span>
        <IconButton
          icon="plus"
          label="Zoom in"
          className="small"
          disabled={view.scale >= ZOOM_MAX}
          onClick={() => zoomAround(ZOOM_STEP)}
        />
        <button type="button" className="btn small" onClick={fit}>
          <Icon name="fit" />
          Fit
        </button>
      </div>
    </div>
  );
}
