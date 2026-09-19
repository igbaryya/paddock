/**
 * The persistent navigation rail: the sections of the app, then the applications themselves as
 * a quick switcher.
 *
 * The switcher is duplication of what the overview grid shows, and it earns its place — moving
 * between two applications while chasing a bug should not mean a round trip through the overview.
 */
import StatusDot from './StatusDot.jsx';
import Icon, { Logo } from './Icon.jsx';
import ThemeSwitcher from './ThemeSwitcher.jsx';
import { Link, paths } from '../router.jsx';

const CONNECTION_LABEL = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

const MOD_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  ? '⌘'
  : 'Ctrl';

/**
 * @param {{applications: object[], route: object, connection: string, portCount: number|null,
 *          onCreate: () => void, onOpenPalette: () => void}} props
 */
export default function Sidebar({ applications, route, connection, portCount, onCreate, onOpenPalette }) {
  const onOverview = route.name === 'overview';
  const onPorts = route.name === 'ports';
  const onMcp = route.name === 'mcp';
  const onSettings = route.name === 'settings';

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-head">
        <Link to={paths.overview()} className="brand">
          <Logo size={24} />
          <span className="brand-name">Paddock</span>
        </Link>
        <span className={`conn conn-${connection}`} role="status">
          <span className="sr-only">Connection: </span>
          {CONNECTION_LABEL[connection]}
        </span>
      </div>

      <button type="button" className="sidebar-search" onClick={onOpenPalette}>
        <Icon name="search" size={15} />
        <span className="sidebar-search-label">Search…</span>
        <kbd className="command-kbd">{MOD_LABEL}K</kbd>
      </button>

      <ul className="nav-list">
        <li>
          <Link
            to={paths.overview()}
            className={`nav-item${onOverview ? ' active' : ''}`}
            aria-current={onOverview ? 'page' : undefined}
          >
            <Icon name="grid" />
            Applications
            <span className="nav-count">{applications.length}</span>
          </Link>
        </li>
        <li>
          <Link
            to={paths.ports()}
            className={`nav-item${onPorts ? ' active' : ''}`}
            aria-current={onPorts ? 'page' : undefined}
          >
            <Icon name="ports" />
            Local ports
            {portCount !== null && <span className="nav-count">{portCount}</span>}
          </Link>
        </li>
        <li>
          <Link
            to={paths.mcp()}
            className={`nav-item${onMcp ? ' active' : ''}`}
            aria-current={onMcp ? 'page' : undefined}
          >
            <Icon name="braces" />
            MCP
          </Link>
        </li>
        <li>
          <Link
            to={paths.settings()}
            className={`nav-item${onSettings ? ' active' : ''}`}
            aria-current={onSettings ? 'page' : undefined}
          >
            <Icon name="settings" />
            Settings
          </Link>
        </li>
      </ul>

      {applications.length > 0 && (
        <div className="sidebar-section">
          <p className="sidebar-label">Switch to</p>
          <ul className="app-list">
            {applications.map((application) => {
              const active = route.applicationId === application.id;
              return (
                <li key={application.id}>
                  <Link
                    to={paths.application(application.id)}
                    className={`app-row${active ? ' selected' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <StatusDot status={application.status} />
                    <span className="app-name">{application.name}</span>
                    <span className="app-count">
                      {application.processCounts.running}/{application.processCounts.enabled}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* The always-there controls, pinned together so each is one click from any page. */}
      <div className="sidebar-foot">
        <ThemeSwitcher />
        <button type="button" className="nav-item sidebar-add" onClick={onCreate}>
          <Icon name="plus" />
          New application
        </button>
      </div>
    </nav>
  );
}
