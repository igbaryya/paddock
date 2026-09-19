/**
 * The panel that slides in over the right of the canvas to detail whichever card is selected.
 *
 * Deliberately not a dialog. A dialog would take the whole screen hostage — focus trapped, the page
 * behind it inert — and the point of this one is that the canvas stays right there: you read a
 * process's log in here, start the process next to it, and watch both without closing anything.
 * So there is no focus trap and no scrim that swallows clicks; a click on the canvas lands on the
 * canvas, and the canvas clearing its selection is what closes this.
 *
 * Escape closes it, because a panel that appeared over your work must always be dismissible from
 * the keyboard, and focus moves into it on open so the keyboard arrives where the eye already is.
 *
 * It is the caller that owns which card is selected, so closing here only reports it: this panel is
 * mounted and unmounted by the canvas, and never hides itself while staying on the page.
 */
import { useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import Segmented from './Segmented.jsx';

/**
 * @param {{leading?: import('react').ReactNode, title: string,
 *          subtitle?: import('react').ReactNode, tabs?: {id: string, label: string}[],
 *          activeTab?: string, onTabChange?: (id: string) => void, onClose: () => void,
 *          children: import('react').ReactNode}} props
 */
export default function Drawer({
  leading,
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  children,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    // Not autofocus on an inner control: the first thing in here may be a log viewport, and moving
    // the caret into a control the user did not aim at is worse than focusing the panel itself.
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  // On window, which is the last stop in the propagation path: a form opened from in here listens on
  // document and stops the key there, so Escape dismisses the topmost layer only.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <aside className="drawer" aria-label={`${title} details`} ref={panelRef} tabIndex={-1}>
      <header className="drawer-head">
        {leading}
        <div className="drawer-heading">
          <h2 title={title}>{title}</h2>
          {subtitle && <p className="drawer-subtitle">{subtitle}</p>}
        </div>
        <IconButton icon="close" label="Close details" className="small ghost" onClick={onClose} />
      </header>

      {tabs && tabs.length > 1 && (
        <div className="drawer-tabs">
          <Segmented
            options={tabs}
            value={activeTab}
            onChange={onTabChange}
            label="Details"
            role="tablist"
          />
        </div>
      )}

      <div className="drawer-body">{children}</div>
    </aside>
  );
}

/**
 * A run of labelled values — the shape most of the drawer's tabs are. Machine text (paths, commands,
 * pids) wraps rather than being cut: there is room here, and this is where someone comes to read the
 * whole of a value the card could only show the end of.
 * @param {{rows: {label: string, value: import('react').ReactNode, mono?: boolean}[]}} props
 */
export function DrawerFacts({ rows }) {
  return (
    <dl className="drawer-facts">
      {rows.map(({ label, value, mono }) => (
        <div key={label} className="drawer-fact">
          <dt>{label}</dt>
          <dd className={mono ? 'mono' : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A titled block inside the drawer's body, so a tab with several concerns in it still reads as
 * sections rather than as one long list.
 * @param {{title: string, action?: import('react').ReactNode,
 *          children: import('react').ReactNode}} props
 */
export function DrawerSection({ title, action, children }) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The drawer's own empty state, for a tab with nothing in it yet. */
export function DrawerEmpty({ icon = 'info', children }) {
  return (
    <p className="drawer-empty">
      <Icon name={icon} size={14} />
      {children}
    </p>
  );
}
