/**
 * The terminal panel docked to the bottom of the application workspace, like VS Code's integrated
 * terminal — the canvas stays above it and keeps working, nothing behind it goes inert, and the top
 * edge drags to resize.
 */
import { useEffect, useRef, useState } from 'react';

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;

/** The canvas keeps at least this much of the window, however tall the panel is dragged. */
const maxHeight = () => Math.min(window.innerHeight * 0.85, window.innerHeight - 120);

const clampHeight = (height) => Math.min(maxHeight(), Math.max(MIN_HEIGHT, height));

/**
 * @param {{onClose: () => void, children: import('react').ReactNode}} props
 */
export default function TerminalDrawer({ onClose, children }) {
  // Clamped from the start too: a short window must not open the panel over most of the canvas.
  const [height, setHeight] = useState(() =>
    clampHeight(Math.min(DEFAULT_HEIGHT, window.innerHeight * 0.4))
  );
  const drawerRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    drawerRef.current?.focus({ preventScroll: true });
  }, []);

  // On the panel itself, so only an Escape pressed in here is ours: one pressed in a dialog or the
  // palette on top never passes through, and they dismiss themselves. Every Escape from in here stops
  // at the panel, so the canvas drawer listening on window is never closed from inside a terminal.
  useEffect(() => {
    const drawer = drawerRef.current;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // The menu is a layer on top and listens on document; let the key reach it.
      if (event.target.closest('[role="menu"]')) return;
      event.stopPropagation();
      // The shell's key, not ours: vim, less and fzf all need Escape.
      if (event.target.closest('.xterm')) return;
      onClose();
    };
    drawer.addEventListener('keydown', onKeyDown);
    return () => drawer.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // A window made shorter takes the panel down with it rather than pushing the canvas off screen.
  useEffect(() => {
    const onResize = () => setHeight(clampHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onResizeStart = (event) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: height };

    const onMove = (moveEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - moveEvent.clientY;
      setHeight(clampHeight(dragRef.current.startHeight + delta));
    };

    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  return (
    <section
      className="terminal-drawer"
      aria-label="Terminal panel"
      ref={drawerRef}
      tabIndex={-1}
      style={{ height }}
    >
      <div
        className="terminal-drawer-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onPointerDown={onResizeStart}
      />
      {children}
    </section>
  );
}
