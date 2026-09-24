/**
 * The version this app is, and whether a newer one is on its way — the same offer the tray makes,
 * in the window, for someone who never opens the tray.
 *
 * Only in the desktop app: a checkout updates through git, and its caller does not render this at
 * all. Installing stops every running service before the app relaunches, which is why it asks first
 * and says so; the tray's label says the same.
 */
import Icon from './Icon.jsx';
import SettingsGroup from './SettingsGroup.jsx';

const formatWhen = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
};

/** One sentence for where the updater stands. @param {object|null} state */
function describe(state) {
  if (!state) return 'Checking the update status…';
  const checked = state.checkedAt && formatWhen(state.checkedAt);
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading ${state.version ?? 'the update'}${state.progress != null ? ` — ${Math.round(state.progress)}%` : '…'}`;
    case 'ready':
      return `${state.version} is downloaded and ready to install.`;
    case 'up-to-date':
      return checked ? `Up to date. Last checked ${checked}.` : 'Up to date.';
    case 'error':
      return `The last check failed: ${state.error ?? 'unknown error'}`;
    case 'unavailable':
      return 'Updates are not available for this build.';
    default:
      return checked ? `Last checked ${checked}.` : 'Checked automatically at launch and every few hours.';
  }
}

/** @param {{updates: NonNullable<ReturnType<typeof import('../useDesktopUpdates.js').useDesktopUpdates>>}} props */
export default function UpdatesGroup({ updates }) {
  const { version, state, check, install } = updates;
  const status = state?.status;
  const busy = status === 'checking' || status === 'downloading';

  const confirmInstall = () => {
    const message =
      `Install ${state.version} and restart Paddock?\n\n` +
      'Every running service is stopped before the update installs.';
    if (window.confirm(message)) install();
  };

  return (
    <SettingsGroup title="Version and updates">
      <div className="group-row">
        <span className="row-icon"><Icon name="info" size={14} /></span>
        <div className="row-text">
          <span className="row-title">Paddock {version ?? ''}</span>
          <span className={`row-sub${status === 'error' ? ' danger' : ''}`} role="status">
            {describe(state)}
          </span>
        </div>
        {status === 'ready' ? (
          <button type="button" className="btn small primary" onClick={confirmInstall}>
            Install and restart
          </button>
        ) : (
          status !== 'unavailable' && (
            <button type="button" className="btn small" disabled={busy || !state} onClick={() => check().catch(() => {})}>
              Check for updates
            </button>
          )
        )}
      </div>
    </SettingsGroup>
  );
}
