/**
 * Dialog shell. Configuration forms are a sheet over a dimmed window; the logger is the same
 * object taking the whole window, because a tail in a 600px sheet is the drawer all over again.
 * Escape closes it, focus moves into it on open and back to whatever opened it on close, so a
 * keyboard user is never dropped at the top of the page.
 */
import { useEffect, useId, useRef } from 'react';
import IconButton from './IconButton.jsx';

const FOCUSABLE = 'input, textarea, select, button';

/**
 * @param {{title: string, onClose: () => void, children: React.ReactNode,
 *          size?: 'sheet'|'full'}} props
 *   `full` is the logger: the same shell, taking the window, because a tail in a 600px sheet is
 *   the drawer all over again.
 */
export default function Modal({ title, onClose, children, size = 'sheet' }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  // Read through a ref: the caller passes a fresh arrow every render, and a dependency on it would
  // re-run the effect on every keystroke and pull focus back to the first field.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current.querySelector(FOCUSABLE)?.focus();
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // Stopped here on the way to window, where the canvas's drawer is listening: a form opened
      // from that drawer is the layer on top, so Escape must dismiss this and only this. Without
      // it one press would close the form and the panel that opened it.
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${size === 'full' ? ' full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {size === 'full' && (
            <IconButton icon="close" label="Close" className="small ghost" onClick={onClose} />
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
