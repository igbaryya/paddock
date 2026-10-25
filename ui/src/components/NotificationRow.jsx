/**
 * One notification as a row that opens what it is about: the application of a process that crashed,
 * Settings for an update. Drawn the same in the bell's panel and on the dashboard, which list the
 * same notifications.
 */
import Icon from './Icon.jsx';
import { Link, paths } from '../router.jsx';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * @param {{item: import('../useNotifications.js').Notification, onOpen?: () => void}} props
 *   `onOpen` runs as the row is followed — the bell closes its panel
 */
export default function NotificationRow({ item, onOpen }) {
  const to = item.applicationId ? paths.application(item.applicationId) : paths.settings();
  return (
    <li>
      <Link to={to} className="notifications-row" onClick={onOpen}>
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
      </Link>
    </li>
  );
}
