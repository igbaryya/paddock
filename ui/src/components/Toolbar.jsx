/**
 * The top of every page, drawn the way the OS draws a window's toolbar: the title on the left, the
 * page's own controls on the right, on a strip of material that stays put while the page scrolls
 * under it. A page that sits below another carries a back button to it, where the OS puts one.
 */
import Icon from './Icon.jsx';
import { Link } from '../router.jsx';

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
    </header>
  );
}
