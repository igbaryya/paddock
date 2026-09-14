/**
 * Settings for Paddock itself, as opposed to anything it runs: whether it starts when you log in,
 * which applications it starts when it does, and the facts about this copy that decide what the
 * login entry would start.
 *
 * The login switch and the facts are fetched here: nothing changes them except this page, so there
 * is nothing to push. The applications are the shell's live list instead, because they change from
 * everywhere — created, renamed and deleted on other screens.
 */
import { useEffect, useId, useState } from 'react';
import * as api from '../api.js';
import Icon from '../components/Icon.jsx';
import StatusDot from '../components/StatusDot.jsx';
import ThemeSwitcher from '../components/ThemeSwitcher.jsx';
import { useTheme } from '../useTheme.js';

/**
 * The one setting that is not Paddock's: it lives in this browser, so it is saved the moment it is
 * picked and never goes through the manager.
 */
function Appearance() {
  const titleId = useId();
  const { preference, resolved } = useTheme();

  return (
    <section className="panel settings-section" aria-labelledby={titleId}>
      <div className="setting-row">
        <div className="setting-text">
          <h2 id={titleId}>Appearance</h2>
          <p className="setting-state">
            {preference === 'system'
              ? `Following your system, which is ${resolved} right now.`
              : `Always ${resolved}, whatever your system is set to.`}
          </p>
          <p className="hint">Saved in this browser only.</p>
        </div>
        <ThemeSwitcher />
      </div>
    </section>
  );
}

/**
 * One sentence for where the switch stands. The case worth spelling out is "on, but not in effect":
 * turning it on never starts anything now, and a switch that says On beside a copy started by hand
 * would otherwise read as if this copy were the login item.
 */
function stateOf(status) {
  if (!status.supported) return status.reason;
  if (!status.enabled) return 'Off. Paddock runs only when you start it yourself.';
  if (status.problems.length) return 'On, but the entry will not start this copy of Paddock.';
  if (status.launchedAtLogin) return 'On. This copy was started at login.';
  return 'On. It takes effect at your next login; this copy was started by hand.';
}

/**
 * The toggle, as a checkbox with the switch role: native keyboard and form behaviour, and a screen
 * reader announces on/off rather than checked/unchecked.
 * @param {{checked: boolean, disabled: boolean, label: string, onChange: (next: boolean) => void}} props
 */
function Switch({ checked, disabled, label, onChange }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}

/** @param {{status: object, saving: boolean, onChange: (enabled: boolean) => void}} props */
function StartAtLogin({ status, saving, onChange }) {
  const titleId = useId();
  const handOver = status.enabled && !status.launchedAtLogin && !status.problems.length;

  return (
    <section className="panel settings-section" aria-labelledby={titleId}>
      <div className="setting-row">
        <div className="setting-text">
          <h2 id={titleId}>Start at login</h2>
          <p className="setting-state" role="status">
            {saving ? 'Saving…' : stateOf(status)}
          </p>
          {status.note && <p className="hint">{status.note}</p>}
        </div>
        <Switch
          checked={status.enabled}
          disabled={saving || !status.supported}
          label="Start Paddock at login"
          onChange={onChange}
        />
      </div>

      {status.problems.length > 0 && (
        <div className="notice warn">
          <Icon name="alert" />
          <span>{status.problems.join(' ')}</span>
          <button type="button" className="btn small" disabled={saving} onClick={() => onChange(true)}>
            Point it at this copy
          </button>
        </div>
      )}

      {handOver && status.startNowCommand && (
        <p className="setting-hint">
          To switch over without logging out, stop this copy (that stops the services it runs), then
          run <code>{status.startNowCommand}</code>
        </p>
      )}

      {status.supported && (
        <dl className="process-facts settings-facts">
          <dt>entry</dt>
          <dd><code>{status.location}</code></dd>
          {status.runs && (
            <>
              <dt>runs</dt>
              <dd>
                <code className="cmd">{[status.runs.program, ...status.runs.args].join(' ')}</code>
              </dd>
            </>
          )}
          <dt>log</dt>
          <dd><code>{status.logFile}</code></dd>
        </dl>
      )}
    </section>
  );
}

/** An application whose processes are all disabled would be "started" into doing nothing. */
const processesLabel = ({ enabled }) =>
  enabled === 0 ? 'no enabled processes' : `${enabled} enabled process${enabled === 1 ? '' : 'es'}`;

/**
 * @param {{applications: object[], startAtLogin: object|null, isBusy: (id: string) => boolean,
 *          onChange: (applicationId: string, autoStart: boolean) => void}} props
 */
function AutoStartApplications({ applications, startAtLogin, isBusy, onChange }) {
  const titleId = useId();
  const chosen = applications.filter((application) => application.autoStart).length;

  return (
    <section className="panel settings-section" aria-labelledby={titleId}>
      <div className="setting-text">
        <h2 id={titleId}>Start applications with Paddock</h2>
        <p className="setting-state">
          {chosen === 0
            ? 'None. Paddock starts with nothing running.'
            : `${chosen} of ${applications.length} start as soon as Paddock does.`}
        </p>
        <p className="hint">
          One after another, in this order, each with its enabled processes only — whether Paddock
          was started at login or by hand.
        </p>
      </div>

      {chosen > 0 && startAtLogin && !startAtLogin.enabled && (
        <p className="setting-hint">
          Start at login is off, so these come up only when you start Paddock yourself.
        </p>
      )}

      {applications.length === 0 ? (
        <p className="empty-text">No applications yet.</p>
      ) : (
        <ul className="autostart-list">
          {applications.map((application) => (
            <li key={application.id} className="autostart-row">
              <StatusDot status={application.status} />
              <span className="app-name">{application.name}</span>
              <span className="app-count">{processesLabel(application.processCounts)}</span>
              <Switch
                checked={application.autoStart}
                disabled={isBusy(application.id)}
                label={`Start ${application.name} with Paddock`}
                onChange={(next) => onChange(application.id, next)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** @param {{instance: object}} props */
function ThisCopy({ instance }) {
  const titleId = useId();
  return (
    <section className="panel settings-section" aria-labelledby={titleId}>
      <div className="setting-text">
        <h2 id={titleId}>This copy</h2>
        <p className="hint">What Start at login would start, and where it keeps its data.</p>
      </div>
      <dl className="process-facts settings-facts">
        <dt>install</dt>
        <dd><code>{instance.installDir}</code></dd>
        <dt>node</dt>
        <dd><code>{instance.nodeVersion}</code> <code>{instance.nodePath}</code></dd>
        <dt>data</dt>
        <dd><code>{instance.dataDir}</code></dd>
        <dt>pid</dt>
        <dd><code>{instance.pid}</code></dd>
      </dl>
    </section>
  );
}

/**
 * @param {{applications: object[], isBusy: (id: string) => boolean,
 *          onAutoStart: (applicationId: string, autoStart: boolean) => void}} props
 */
export default function SettingsPage({ applications, isBusy, onAutoStart }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getSettings(controller.signal)
      .then(setSettings)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, []);

  const setStartAtLogin = async (enabled) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.updateSettings({ startAtLogin: enabled }));
    } catch (err) {
      setError(err.message); // the manager's own text: a permission error names the file it hit
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">Paddock itself: how it starts, and where it keeps things.</p>
        </div>
      </header>

      {error && (
        <p className="notice danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      <div className="settings">
        <Appearance />
        {settings ? (
          <StartAtLogin status={settings.startAtLogin} saving={saving} onChange={setStartAtLogin} />
        ) : (
          !error && <p className="empty-text">Reading settings…</p>
        )}
        <AutoStartApplications
          applications={applications}
          startAtLogin={settings?.startAtLogin ?? null}
          isBusy={isBusy}
          onChange={onAutoStart}
        />
        {settings && <ThisCopy instance={settings.instance} />}
      </div>
    </>
  );
}
