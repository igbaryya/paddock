/**
 * Settings for Paddock itself, as opposed to anything it runs. Laid out the way the OS lays out its
 * own settings — titled groups of rows, each row a label on the left and its control on the right.
 *
 * Startup is one group because it is one sequence: the login entry starts Paddock, and Paddock starts
 * the chosen applications one after another. The facts about this copy — what the login entry would
 * start, where the data lives — are for when something is wrong, so they fold away behind a one-line
 * summary instead of being the bulk of the page.
 *
 * The login switch and the facts are fetched here: nothing changes them except this page, so there
 * is nothing to push. The applications are the shell's live list instead, because they change from
 * everywhere — created, renamed and deleted on other screens.
 */
import { useEffect, useId, useState } from 'react';
import * as api from '../api.js';
import CopyButton from '../components/CopyButton.jsx';
import Icon from '../components/Icon.jsx';
import Switch from '../components/Switch.jsx';
import ThemeSwitcher from '../components/ThemeSwitcher.jsx';
import Toolbar from '../components/Toolbar.jsx';
import { useTheme } from '../useTheme.js';

/**
 * A titled group of rows, with the small print underneath it where the OS puts a group's footnote.
 * @param {{title: string, note?: React.ReactNode, children: React.ReactNode}} props
 */
function SettingsGroup({ title, note, children }) {
  const titleId = useId();
  return (
    <section className="settings-section" aria-labelledby={titleId}>
      <h2 className="group-title" id={titleId}>{title}</h2>
      <div className="group">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  );
}

/** @param {{children: React.ReactNode}} props a row that only says something */
const TextRow = ({ children }) => (
  <div className="group-row">
    <span className="row-sub">{children}</span>
  </div>
);

/** @param {{label: string, children: React.ReactNode}} props one fact, as a row of the group */
const Fact = ({ label, children }) => (
  <div className="fact">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** @param {{label: string, value: string}} props a fact that is a path, whole, and copyable */
const PathFact = ({ label, value }) => (
  <Fact label={label}>
    <code>{value}</code>
    <CopyButton text={value} label={`Copy the ${label.toLowerCase()} path`} />
  </Fact>
);

/** @param {{command: string}} props a command to paste into a terminal, drawn as one */
const CommandWell = ({ command }) => (
  <div className="command-well">
    <code>{command}</code>
    <CopyButton text={command} label="Copy the command" />
  </div>
);

/**
 * The one setting that is not Paddock's: it lives in this browser, so it is saved the moment it is
 * picked and never goes through the manager.
 */
function Appearance() {
  const { preference, resolved } = useTheme();

  return (
    <SettingsGroup title="Appearance" note="Saved in this browser only.">
      <div className="group-row">
        <span className="row-icon"><Icon name={resolved === 'light' ? 'sun' : 'moon'} size={14} /></span>
        <div className="row-text">
          <span className="row-title">Theme</span>
          <span className="row-sub">
            {preference === 'system'
              ? `Following your system, which is ${resolved} right now.`
              : `Always ${resolved}, whatever your system is set to.`}
          </span>
        </div>
        <ThemeSwitcher />
      </div>
    </SettingsGroup>
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
 * The login switch, and under it whatever stands between the switch and it actually working.
 * @param {{status: object, saving: boolean, onChange: (enabled: boolean) => void}} props
 */
function StartAtLogin({ status, saving, onChange }) {
  const handOver = status.enabled && !status.launchedAtLogin && !status.problems.length;

  return (
    <>
      <div className="group-row">
        <span className="row-icon"><Icon name="power" size={14} /></span>
        <div className="row-text">
          <span className="row-title">Open Paddock when you log in</span>
          <span className="row-sub" role="status">
            {saving ? 'Saving…' : stateOf(status)}
          </span>
        </div>
        <Switch
          checked={status.enabled}
          disabled={saving || !status.supported}
          label="Start Paddock at login"
          onChange={onChange}
        />
      </div>

      {status.problems.length > 0 && (
        <div className="group-row row-warn">
          <Icon name="alert" />
          <span className="row-text row-sub">{status.problems.join(' ')}</span>
          <button type="button" className="btn small" disabled={saving} onClick={() => onChange(true)}>
            Point it at this copy
          </button>
        </div>
      )}

      {handOver && status.startNowCommand && (
        <div className="group-row row-detail">
          <p className="row-sub">
            To switch over without logging out, stop this copy — that stops the services it runs —
            then run:
          </p>
          <CommandWell command={status.startNowCommand} />
        </div>
      )}
    </>
  );
}

/** An application whose processes are all disabled would be "started" into doing nothing. */
const processesLabel = ({ enabled }) =>
  enabled === 0 ? 'No enabled processes' : `${enabled} enabled process${enabled === 1 ? '' : 'es'}`;

/** Each chosen application's place in the start sequence, which is the order of the list. */
const startPositions = (applications) =>
  new Map(applications.filter((application) => application.autoStart).map(({ id }, i) => [id, i + 1]));

/**
 * @param {{applications: object[], isBusy: (id: string) => boolean,
 *          onChange: (applicationId: string, autoStart: boolean) => void}} props
 */
function AutoStartRows({ applications, isBusy, onChange }) {
  if (applications.length === 0) return <TextRow>No applications yet.</TextRow>;

  const positions = startPositions(applications);
  return applications.map((application) => (
    <div key={application.id} className="group-row">
      <span className={`row-order${positions.has(application.id) ? ' chosen' : ''}`}>
        {positions.get(application.id) ?? <span aria-hidden="true">–</span>}
      </span>
      <div className="row-text">
        <span className="row-title">{application.name}</span>
        <span className="row-sub">{processesLabel(application.processCounts)}</span>
      </div>
      <Switch
        checked={application.autoStart}
        disabled={isBusy(application.id)}
        label={`Start ${application.name} with Paddock`}
        onChange={(next) => onChange(application.id, next)}
      />
    </div>
  ));
}

/** What the sequence as a whole will do, and the platform's caveat about the login entry. */
function startupNote(applications, startAtLogin) {
  const chosen = applications.filter((application) => application.autoStart).length;
  const sequence = chosen === 0
    ? 'No applications are chosen, so Paddock starts with nothing running.'
    : `${chosen} of ${applications.length} start in the numbered order, each with only its enabled processes.`;
  const off = chosen > 0 && startAtLogin && !startAtLogin.enabled
    ? 'Start at login is off, so these come up only when you start Paddock yourself.'
    : null;
  return [startAtLogin?.note, applications.length > 0 && sequence, off].filter(Boolean).join(' ');
}

/**
 * @param {{startAtLogin: object|null, unreadable: boolean, saving: boolean,
 *          onStartAtLogin: (enabled: boolean) => void, applications: object[],
 *          isBusy: (id: string) => boolean,
 *          onAutoStart: (applicationId: string, autoStart: boolean) => void}} props
 *   `unreadable` is whether the settings request failed, which is what ends "Reading…"
 */
function Startup({ startAtLogin, unreadable, saving, onStartAtLogin, applications, isBusy, onAutoStart }) {
  return (
    <SettingsGroup title="Startup" note={startupNote(applications, startAtLogin)}>
      {startAtLogin ? (
        <StartAtLogin status={startAtLogin} saving={saving} onChange={onStartAtLogin} />
      ) : (
        <TextRow>{unreadable ? 'The login setting could not be read.' : 'Reading settings…'}</TextRow>
      )}
      <p className="group-subhead">When Paddock starts, one after another</p>
      <AutoStartRows applications={applications} isBusy={isBusy} onChange={onAutoStart} />
    </SettingsGroup>
  );
}

/** The last segment of an install path — the checkout's name, which is what tells two copies apart. */
const folderName = (directory) => directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;

/**
 * The facts, folded behind the three that identify the copy at a glance. "Runs" is shown only when
 * the entry is stale: otherwise it is exactly this copy's node and install folder, listed above.
 * @param {{instance: object, startAtLogin: object}} props
 */
function AboutThisCopy({ instance, startAtLogin }) {
  const [open, setOpen] = useState(false);
  const stale = startAtLogin.problems.length > 0 && startAtLogin.runs;

  return (
    <SettingsGroup title="About this copy" note="What Start at login would start, and where it keeps its data.">
      <button
        type="button"
        className="group-row group-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="row-icon"><Icon name="info" size={14} /></span>
        <span className="row-text">
          <span className="row-title">{folderName(instance.installDir)}</span>
          <span className="row-sub">pid {instance.pid} · node {instance.nodeVersion}</span>
        </span>
        <Icon name="chevron" size={14} className={open ? 'rotated' : ''} />
      </button>

      {open && (
        <>
          <dl className="group-facts">
            <PathFact label="Install" value={instance.installDir} />
            <PathFact label="Data" value={instance.dataDir} />
            <PathFact label="Node" value={instance.nodePath} />
          </dl>
          {startAtLogin.supported && (
            <>
              <p className="group-subhead">Login entry</p>
              <dl className="group-facts">
                <PathFact label="File" value={startAtLogin.location} />
                {stale && (
                  <Fact label="Runs">
                    <code>{[startAtLogin.runs.program, ...startAtLogin.runs.args].join(' ')}</code>
                  </Fact>
                )}
                <PathFact label="Log" value={startAtLogin.logFile} />
              </dl>
            </>
          )}
        </>
      )}
    </SettingsGroup>
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
      <Toolbar title="Settings" subtitle="Paddock itself: how it starts, and where it keeps things." />

      <div className="settings">
        {error && (
          <p className="notice danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <Appearance />
        <Startup
          startAtLogin={settings?.startAtLogin ?? null}
          unreadable={!settings && error !== null}
          saving={saving}
          onStartAtLogin={setStartAtLogin}
          applications={applications}
          isBusy={isBusy}
          onAutoStart={onAutoStart}
        />
        {settings && <AboutThisCopy instance={settings.instance} startAtLogin={settings.startAtLogin} />}
      </div>
    </>
  );
}
