/**
 * The bell in the toolbar's corner: an unread badge, and a panel of what needs attention. Opening
 * the panel is what marks everything read.
 */
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { Link, paths } from '../router.jsx';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * @param {{notifications: ReturnType<typeof import('../useNotifications.js').useNotifications>}} props
 */
export default function NotificationsButton({ notifications }) {
  const { items, unread, markRead, clear } = notifications;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!anchorRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Whatever arrives while the panel is open has been seen.
  useEffect(() => {
    if (open) markRead();
  }, [open, items, markRead]);

  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className="btn icon-button ghost notifications-button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="notifications-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="menu notifications-menu" role="dialog" aria-label="Notifications">
          <div className="notifications-head">
            <Icon name="bell" />
            <span>Notifications</span>
            {items.length > 0 && (
              <button type="button" className="btn small ghost" onClick={clear}>
                Clear
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="notifications-empty">Nothing needs attention.</p>
          ) : (
            <ul className="notifications-list">
              {items.map((item) => {
                const body = (
                  <>
                    <span className={`notifications-icon is-${item.kind}`} aria-hidden="true">
                      <Icon name={item.kind === 'update' ? 'arrow-down' : 'alert'} size={14} />
                    </span>
                    <span className="notifications-copy">
                      <span className="notifications-title">{item.title}</span>
                      {item.detail && <span className="notifications-detail">{item.detail}</span>}
                    </span>
                    <time className="notifications-time" dateTime={new Date(item.ts).toISOString()}>
                      {timeFormat.format(item.ts)}
                    </time>
                  </>
                );
                const to = item.applicationId ? paths.application(item.applicationId) : paths.settings();
                return (
                  <li key={item.id}>
                    <Link to={to} className="notifications-row" onClick={() => setOpen(false)}>
                      {body}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
