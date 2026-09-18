/**
 * Create or edit an application — its kind and its identity, and nothing else. Every kind is named
 * here and filled in on its own page: a group of processes gets its processes there, and an app gets
 * its server defined from its box there.
 *
 * The kind is picked in two steps: your own local processes, or one of the apps Paddock knows how to
 * run, each a card — and there is nothing to name until an app is picked, so the fields wait for the
 * click. It is chosen once, at creation. The manager refuses to change it afterwards, so the edit
 * form does not offer a choice it would only reject.
 */
import { useId, useState } from 'react';
import Modal from './Modal.jsx';
import Field, { nameError } from './Field.jsx';
import Icon from './Icon.jsx';

const TABS = [
  { value: 'processes', icon: 'terminal', label: 'Local processes' },
  { value: 'apps', icon: 'grid', label: 'Apps' },
];

const PROCESSES_HINT =
  'Repositories and the command that starts each one — you add them once the application exists.';

const PICK_HINT = 'Pick the app this application runs.';

/**
 * One card per kind of app, with its logo from public/. `kind` is what the manager is sent; a `soon`
 * app is shown but cannot be picked, because the manager does not run that kind yet.
 */
const APPS = [
  {
    kind: 'postgres',
    logo: '/postgres.svg',
    label: 'PostgreSQL',
    summary: 'A local cluster, run with pg_ctl',
    hint: 'A PostgreSQL cluster already created with initdb — you point the application at it once it exists. Paddock starts and stops it with pg_ctl, it keeps running when Paddock stops, and its databases are open to agents over MCP.',
  },
  { kind: 'redis', logo: '/redis.svg', label: 'Redis', soon: true },
];

/** @param {{selected: string|null, onSelect: (kind: string) => void}} props */
function AppChoices({ selected, onSelect }) {
  return (
    <div className="app-choices" role="group" aria-label="App">
      {APPS.map((app) => (
        <button
          key={app.kind}
          type="button"
          className={`app-choice${selected === app.kind ? ' selected' : ''}`}
          aria-pressed={selected === app.kind}
          disabled={app.soon}
          onClick={() => onSelect(app.kind)}
        >
          <span className="app-icon app-icon-md">
            <img src={app.logo} alt="" />
          </span>
          <span className="app-choice-text">
            <span className="app-choice-name">{app.label}</span>
            <span className="app-choice-summary">{app.soon ? 'Coming soon' : app.summary}</span>
          </span>
          {selected === app.kind && <Icon name="check" className="app-choice-check" />}
        </button>
      ))}
    </div>
  );
}

/** @param {string} tab @param {string|null} app */
const hintOf = (tab, app) => {
  if (tab === 'processes') return PROCESSES_HINT;
  return APPS.find((one) => one.kind === app)?.hint ?? PICK_HINT;
};

/**
 * @param {{tab: string, app: string|null, onTabChange: (tab: string) => void,
 *          onAppChange: (kind: string) => void}} props
 */
function KindPicker({ tab, app, onTabChange, onAppChange }) {
  const labelId = useId();
  return (
    <div className="field">
      <span className="field-label" id={labelId}>Kind</span>
      <div className="segmented kind-picker" role="group" aria-labelledby={labelId}>
        {TABS.map(({ value, icon, label }) => (
          <button
            key={value}
            type="button"
            className={`segment${tab === value ? ' selected' : ''}`}
            aria-pressed={tab === value}
            onClick={() => onTabChange(value)}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'apps' && <AppChoices selected={app} onSelect={onAppChange} />}
      <p className="hint">{hintOf(tab, app)}</p>
    </div>
  );
}

/**
 * @param {{application: object|null, onSubmit: (values: object) => Promise<void>,
 *          onClose: () => void}} props
 */
export default function ApplicationForm({ application, onSubmit, onClose }) {
  const [name, setName] = useState(application?.name ?? '');
  const [description, setDescription] = useState(application?.description ?? '');
  // The chosen card is kept apart from the tab, so a look at the other tab does not lose it.
  const [tab, setTab] = useState('processes');
  const [app, setApp] = useState(null);
  const kind = tab === 'apps' ? app : 'processes';
  // An edit has its kind already; a new application has one once its tab or card says what it is.
  const chosen = Boolean(application || kind);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const invalid = nameError(name) ? { name: nameError(name) } : {};
    setErrors(invalid);
    if (Object.keys(invalid).length) return;

    setServerError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        // The kind is only ever sent on create; the manager rejects a change of it.
        ...(application ? {} : { kind }),
      });
    } catch (err) {
      setServerError(err.message); // the manager is authoritative; show exactly what it said
      setSaving(false);
    }
  };

  return (
    <Modal title={application ? 'Edit application' : 'New application'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {!application && (
          <KindPicker tab={tab} app={app} onTabChange={setTab} onAppChange={setApp} />
        )}
        {chosen && (
          <div className="form-section">
            <Field label="Name" value={name} onChange={setName} error={errors.name} />
            <Field
              label="Description"
              value={description}
              onChange={setDescription}
              rows={2}
              hint="Optional. What this application is, for whoever opens the dashboard next."
              spellCheck
            />
          </div>
        )}
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving || !chosen}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
