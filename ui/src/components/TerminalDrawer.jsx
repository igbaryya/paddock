/**
 * The terminal panel docked to the bottom of the application workspace, like VS Code's integrated
 * terminal — the canvas stays above it and keeps working, nothing behind it goes inert, and the top
 * edge drags to resize.
 */
import { useEffect, useRef, useState } from 'react';

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;

/**
 * @param {{onClose: () => void, children: import('react').ReactNode}} props
 */
export default function TerminalDrawer({ onClose, children }) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const drawerRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    drawerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // Capture and stop: the canvas drawer is listening on window too, and one Escape should dismiss
      // the panel on top, not every panel that happens to be open.
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const onResizeStart = (event) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: height };
    const max = Math.min(window.innerHeight * 0.85, window.innerHeight - 120);

    const onMove = (moveEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - moveEvent.clientY;
      setHeight(
        Math.min(max, Math.max(MIN_HEIGHT, dragRef.current.startHeight + delta))
      );
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
