/**
 * The persistent navigation rail: the sections of the app, then the applications themselves as
 * a quick switcher.
 *
 * The switcher is duplication of what the overview grid shows, and it earns its place — moving
 * between two applications while chasing a bug should not mean a round trip through the overview.
 *
 * Collapsed, the rail keeps every destination as an icon, with its name as a tooltip. Labels are
 * hidden by CSS rather than unmounted, so the rows keep their place and focus order either way.
 */
import StatusDot from './StatusDot.jsx';
import Icon, { Logo } from './Icon.jsx';
import ThemeSwitcher from './ThemeSwitcher.jsx';
import SystemMeters from './SystemMeters.jsx';
import NetworkSummary from './NetworkSummary.jsx';
import { Link, paths } from '../router.jsx';
import { useDesktopUpdates } from '../useDesktopUpdates.js';
import { formatCombo } from '../shortcuts.js';
import { IS_MAC, useShortcuts } from '../useShortcuts.js';

const CONNECTION_LABEL = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

/** `label (⌘B)`, or just the label when the action has no shortcut. */
const withKeys = (label, combo) => (combo ? `${label} (${formatCombo(combo, IS_MAC)})` : label);

/**
 * @param {{to: string, icon: string, label: string, active: boolean, count?: number|null,
 *          collapsed: boolean}} props
 */
function NavItem({ to, icon, label, active, count, collapsed }) {
  return (
    <li>
      <Link
        to={to}
        className={`nav-item${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : undefined}
      >
        <Icon name={icon} />
        <span className="nav-label">{label}</span>
        {count != null && <span className="nav-count">{count}</span>}
      </Link>
    </li>
  );
}

/**
 * @param {{applications: object[], route: object, connection: string, portCount: number|null,
 *          system: {latest: object|null, history: object[]}, network: object|null,
 *          onCreate: () => void, onOpenPalette: () => void, collapsed: boolean,
 *          onToggleCollapsed: () => void}} props
 */
export default function Sidebar({
  applications,
  route,
  connection,
  portCount,
  system,
  network,
  onCreate,
  onOpenPalette,
  collapsed,
  onToggleCollapsed,
}) {
  // Only a downloaded update earns a place here; checking and failures stay on the Settings page.
  const updates = useDesktopUpdates();
  const updateReady = updates?.state?.status === 'ready';
  const { bindings } = useShortcuts();
  const toggleLabel = withKeys(`${collapsed ? 'Expand' : 'Collapse'} sidebar`, bindings.toggleSidebar);
  const newLabel = withKeys('New application', bindings.newApplication);

  return (
    <nav className="sidebar" aria-label="Main">
      {/* In the macOS window the traffic lights share this row, and it is what drags the window. */}
      <div className="sidebar-top">
        <button
          type="button"
          className="btn icon-button ghost sidebar-toggle"
          onClick={onToggleCollapsed}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          title={toggleLabel}
        >
          <Icon name={collapsed ? 'sidebar-expand' : 'sidebar-collapse'} />
        </button>
      </div>

      <button
        type="button"
        className="sidebar-search"
        onClick={onOpenPalette}
        aria-label={collapsed ? 'Search' : undefined}
        title={collapsed ? withKeys('Search', bindings.palette) : undefined}
      >
        <Icon name="search" size={15} />
        <span className="sidebar-search-label">Search…</span>
        {bindings.palette && <kbd className="command-kbd">{formatCombo(bindings.palette, IS_MAC)}</kbd>}
      </button>

      <ul className="nav-list">
        <NavItem
          to={paths.overview()}
          icon="grid"
          label="Applications"
          active={route.name === 'overview'}
          count={applications.length}
          collapsed={collapsed}
        />
        <NavItem
          to={paths.ports()}
          icon="ports"
          label="Local ports"
          active={route.name === 'ports'}
          count={portCount}
          collapsed={collapsed}
        />
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
                    aria-label={collapsed ? application.name : undefined}
                    title={collapsed ? application.name : undefined}
                  >
                    <StatusDot status={application.status} />
                    <span className="app-initial" aria-hidden="true">
                      {application.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
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
        <SystemMeters system={system} stale={connection !== 'live'} />
        <NetworkSummary network={network} stale={connection !== 'live'} />
        {updateReady && (
          <Link
            to={paths.settings()}
            className="nav-item sidebar-update"
            title={collapsed ? `Update ${updates.state.version} ready` : undefined}
          >
            <Icon name="arrow-down" />
            <span className="nav-label">Update {updates.state.version} ready</span>
          </Link>
        )}
        <ThemeSwitcher />
        <button
          type="button"
          className="nav-item sidebar-add"
          onClick={onCreate}
          aria-label={collapsed ? 'New application' : undefined}
          title={newLabel}
        >
          <Icon name="plus" />
          <span className="nav-label">New application</span>
        </button>
        <div className="sidebar-brand">
          <Link to={paths.overview()} className="brand" title={collapsed ? 'Paddock' : undefined}>
            <Logo size={24} />
            <span className="brand-name">Paddock</span>
          </Link>
          <span
            className={`conn conn-${connection}`}
            role="status"
            title={collapsed ? `Connection: ${CONNECTION_LABEL[connection]}` : undefined}
          >
            <span className="sr-only">Connection: </span>
            <span className="conn-label">{CONNECTION_LABEL[connection]}</span>
          </span>
        </div>
      </div>
    </nav>
  );
}
