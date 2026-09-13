/**
 * Dialog shell for the configuration forms. Escape closes it, focus moves into it on open and back
 * to whatever opened it on close, so a keyboard user is never dropped at the top of the page.
 */
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'input, textarea, select, button';

/**
 * @param {{title: string, onClose: () => void, children: React.ReactNode}} props
 */
export default function Modal({ title, onClose, children }) {
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
      if (event.key === 'Escape') closeRef.current();
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
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
