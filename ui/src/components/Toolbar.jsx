/**
 * The top of every page, drawn the way the OS draws a window's toolbar: the title on the left, the
 * page's own controls on the right, on a strip of material that stays put while the page scrolls
 * under it. A page that sits below another carries a back button to it, where the OS puts one.
 *
 * The far right corner is the same on every page but Settings — notifications and Settings — so it
 * comes from context rather than from each page passing it in.
 */
import { createContext, useContext } from 'react';
import Icon from './Icon.jsx';
import NotificationsButton from './NotificationsButton.jsx';
import { Link, paths, useRoute } from '../router.jsx';

/** Provided by App: the notifications the bell shows. */
export const ToolbarCornerContext = createContext(null);

/** Not on Settings itself, which is a page of its own with only a way back out. */
function ToolbarCorner() {
  const notifications = useContext(ToolbarCornerContext);
  const onSettings = useRoute().name === 'settings';
  if (!notifications || onSettings) return null;
  return (
    <div className="toolbar-corner">
      <NotificationsButton notifications={notifications} />
      <Link
        to={paths.settings()}
        className="btn icon-button ghost"
        aria-label="Settings"
        title="Settings"
      >
        <Icon name="settings" />
      </Link>
    </div>
  );
}

/**
 * @param {{title: string, subtitle?: React.ReactNode, back?: {to: string, label: string},
 *          leading?: React.ReactNode, children?: React.ReactNode}} props `leading` sits between the
 *   back button and the title — an application's icon; `children` are the page's controls
 */
export default function Toolbar({ title, subtitle, back, leading, children }) {
  return (
    <header className="toolbar">
      {back && (
        <Link to={back.to} className="btn icon-button" aria-label={back.label} title={back.label}>
          <Icon name="back" />
        </Link>
      )}
      {leading}
      <div className="toolbar-title">
        <h1>{title}</h1>
        {subtitle && <p className="toolbar-subtitle">{subtitle}</p>}
      </div>
      {children && <div className="toolbar-actions">{children}</div>}
      <ToolbarCorner />
    </header>
  );
}
