/**
 * The application header's terminal control: one click opens the menu of open shells and places
 * a new one may be started, rather than jumping straight into the panel.
 */
import { useEffect, useRef, useState } from 'react';
import IconButton from './IconButton.jsx';
import TerminalMenu from './TerminalMenu.jsx';

/**
 * @param {{applicationId: string,
 *          onChoose: (choice: {kind: 'session', sessionId: string} |
 *                              {kind: 'new', processId: string}) => void}} props
 */
export default function TerminalButton({ applicationId, onChoose }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (anchorRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (choice) => {
    setOpen(false);
    onChoose(choice);
  };

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <IconButton
        icon="terminal"
        label="Terminal"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      />
      {open && (
        <TerminalMenu
          applicationId={applicationId}
          onPickSession={(sessionId) => choose({ kind: 'session', sessionId })}
          onPickTarget={(processId) => choose({ kind: 'new', processId })}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
