/**
 * Create or edit an application. A group of processes carries no runtime settings of its own — it is
 * the group its processes are started and stopped as — so for that kind there is nothing here but
 * identity. A PostgreSQL application is its settings: where the cluster lives and how to reach it.
 *
 * The kind is chosen once, at creation. The manager refuses to change it afterwards, so the edit
 * form does not offer a choice it would only reject.
 *
 * A new PostgreSQL application starts from what is already on the machine: the clusters the manager
 * finds are listed above the fields, and picking one fills them in. Nothing is filled in without a
 * click, and every field stays editable after one.
 */
import { useEffect, useId, useState } from 'react';
import Modal from './Modal.jsx';
import Field, { nameError } from './Field.jsx';
import PathField, { isAbsolute } from './PathField.jsx';
import StatusDot from './StatusDot.jsx';
import { discoverClusters } from '../api.js';

const KINDS = [
  ['processes', 'Local processes'],
  ['postgres', 'PostgreSQL'],
];

const DEFAULT_PORT = 5432;

/**
 * Optional fields start blank rather than pre-filled with the manager's defaults: blank is sent as
 * blank and the manager applies its own default, so the browser never has to guess what that is.
 * @param {object|null} settings the application's `postgres` view, when editing
 */
const postgresFormOf = (settings) => ({
  dataDirectory: settings?.dataDirectory ?? '',
  port: String(settings?.port ?? DEFAULT_PORT),
  binDirectory: settings?.binDirectory ?? '',
  user: settings?.user ?? '',
  password: '',
  maintenanceDatabase: settings?.maintenanceDatabase ?? '',
  logFile: settings?.logFile ?? '',
});

/**
 * A found cluster, as form values. What discovery could not establish stays blank, which the manager
 * turns into its default — never into a guess made here.
 */
const postgresFormFrom = (cluster) => ({
  ...postgresFormOf(null),
  dataDirectory: cluster.dataDirectory,
  port: String(cluster.port),
  binDirectory: cluster.binDirectory ?? '',
  user: cluster.user ?? '',
  logFile: cluster.logFile ?? '',
});

/** Mirrors the manager's rules so a typo does not need a round trip; the manager still decides. */
function postgresErrors(form) {
  const found = {};
  const dataDirectory = form.dataDirectory.trim();
  if (!dataDirectory) found.dataDirectory = 'Data directory is required';
  else if (!isAbsolute(dataDirectory)) found.dataDirectory = 'Data directory must be absolute';

  const port = Number(form.port.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    found.port = 'Port must be a whole number between 1 and 65535';
  }

  const binDirectory = form.binDirectory.trim();
  if (binDirectory && !isAbsolute(binDirectory)) found.binDirectory = 'Bin directory must be absolute';

  const logFile = form.logFile.trim();
  if (logFile && !isAbsolute(logFile)) found.logFile = 'Log file must be absolute';
  return found;
}

/**
 * The password is only sent when it is being changed: the manager never hands a saved one back, so
 * an empty field on an edit means "leave it", not "remove it".
 */
const postgresValues = (form, forgetPassword) => ({
  dataDirectory: form.dataDirectory.trim(),
  port: Number(form.port.trim()),
  binDirectory: form.binDirectory.trim() || null,
  user: form.user.trim(),
  maintenanceDatabase: form.maintenanceDatabase.trim(),
  logFile: form.logFile.trim() || null,
  ...(form.password || forgetPassword ? { password: form.password } : {}),
});

/** What a found cluster is doing right now, in the words the rest of the dashboard uses. */
const clusterSummary = (cluster) =>
  cluster.running
    ? `PostgreSQL ${cluster.version} · running on :${cluster.port} · pid ${cluster.pid}`
    : `PostgreSQL ${cluster.version} · stopped · port ${cluster.port}`;

/**
 * The clusters on this machine, one click each. One that an application already runs is shown but
 * not offered: the manager would refuse a second application on the same data directory.
 * @param {{onPick: (cluster: object) => void}} props
 */
function FoundClusters({ onPick }) {
  const [clusters, setClusters] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    discoverClusters(controller.signal)
      .then((found) => setClusters(found.clusters))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, []);

  if (error) return <p className="hint">Could not look for clusters: {error}</p>;
  if (!clusters) return <p className="hint">Looking for PostgreSQL clusters on this machine…</p>;
  if (!clusters.length) {
    return <p className="hint">No clusters found. Point the data directory at one below.</p>;
  }

  return (
    <div className="field">
      <span className="field-label">Found on this machine</span>
      <ul className="picker-list cluster-list">
        {clusters.map((cluster) => (
          <li key={cluster.dataDirectory}>
            <button
              type="button"
              className="picker-entry cluster-option"
              disabled={Boolean(cluster.claimedBy)}
              onClick={() => onPick(cluster)}
            >
              <span className="cluster-path">{cluster.dataDirectory}</span>
              <span className="cluster-meta">
                <StatusDot status={cluster.running ? 'running' : 'stopped'} />
                {cluster.claimedBy ? `already added as ${cluster.claimedBy.name}` : clusterSummary(cluster)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">
        A running cluster keeps running: Paddock picks it up as it is, and stops it only when you ask.
      </p>
    </div>
  );
}

/** @param {{kind: string, onChange: (kind: string) => void}} props */
function KindPicker({ kind, onChange }) {
  const labelId = useId();
  return (
    <div className="field">
      <span className="field-label" id={labelId}>Kind</span>
      <div className="segmented kind-picker" role="group" aria-labelledby={labelId}>
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`segment${kind === value ? ' selected' : ''}`}
            aria-pressed={kind === value}
            onClick={() => onChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="hint">
        {kind === 'postgres'
          ? 'A PostgreSQL cluster already created with initdb. Paddock starts and stops it with pg_ctl, it keeps running when Paddock stops, and its databases are open to agents over MCP.'
          : 'Repositories and the command that starts each one — you add them once the application exists.'}
      </p>
    </div>
  );
}

/**
 * @param {{form: object, onChange: (form: object) => void, errors: object, passwordSet: boolean,
 *          forgetPassword: boolean, onForgetPassword: (forget: boolean) => void}} props
 */
function PostgresFields({ form, onChange, errors, passwordSet, forgetPassword, onForgetPassword }) {
  const set = (key) => (value) => onChange({ ...form, [key]: value });

  return (
    <>
      <PathField
        label="Data directory"
        value={form.dataDirectory}
        onChange={set('dataDirectory')}
        error={errors.dataDirectory}
        placeholder="/path/to/pgdata"
        hint="The cluster's directory — the one holding PG_VERSION."
        start=""
      />
      <Field label="Port" value={form.port} onChange={set('port')} error={errors.port} mono />
      <Field
        label="User"
        value={form.user}
        onChange={set('user')}
        hint="Optional. The role the database tools connect as; blank uses the account running Paddock."
      />
      <Field
        label="Password"
        type="password"
        value={form.password}
        onChange={set('password')}
        placeholder={passwordSet && !forgetPassword ? 'Saved — type to replace' : ''}
        hint="Optional. Leave blank for trust authentication."
      />
      {passwordSet && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={forgetPassword}
            onChange={(event) => onForgetPassword(event.target.checked)}
          />
          Remove the saved password
        </label>
      )}
      <Field
        label="Maintenance database"
        value={form.maintenanceDatabase}
        onChange={set('maintenanceDatabase')}
        placeholder="postgres"
        hint="Optional. Where cluster-wide work like CREATE DATABASE connects."
      />
      <PathField
        label="Bin directory"
        value={form.binDirectory}
        onChange={set('binDirectory')}
        error={errors.binDirectory}
        placeholder="/opt/homebrew/opt/postgresql@16/bin"
        hint="Optional. Where pg_ctl lives; blank uses the one on your PATH. It must match the version that created the cluster."
        start=""
      />
      <Field
        label="Log file"
        value={form.logFile}
        onChange={set('logFile')}
        error={errors.logFile}
        placeholder="Paddock's own, beside its other logs"
        hint="Optional. Where pg_ctl writes the server's log, and where Paddock reads it from for the log viewer."
        mono
      />
    </>
  );
}

/**
 * @param {{application: object|null, onSubmit: (values: object) => Promise<void>,
 *          onClose: () => void}} props
 */
export default function ApplicationForm({ application, onSubmit, onClose }) {
  const [name, setName] = useState(application?.name ?? '');
  const [description, setDescription] = useState(application?.description ?? '');
  const [kind, setKind] = useState(application?.kind ?? 'processes');
  const [postgres, setPostgres] = useState(() => postgresFormOf(application?.postgres));
  const [forgetPassword, setForgetPassword] = useState(false);
  const [errors, setErrors] = useState({});

  /** A name the user has not typed yet is offered from the cluster; one they have typed is kept. */
  const pickCluster = (cluster) => {
    setPostgres(postgresFormFrom(cluster));
    if (!name.trim()) setName(`PostgreSQL ${cluster.version}`);
    setErrors({});
  };
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const invalid = kind === 'postgres' ? postgresErrors(postgres) : {};
    if (nameError(name)) invalid.name = nameError(name);
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
        ...(kind === 'postgres' ? { postgres: postgresValues(postgres, forgetPassword) } : {}),
      });
    } catch (err) {
      setServerError(err.message); // the manager is authoritative; show exactly what it said
      setSaving(false);
    }
  };

  return (
    <Modal title={application ? 'Edit application' : 'New application'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {!application && <KindPicker kind={kind} onChange={setKind} />}
        {kind === 'postgres' && !application && <FoundClusters onPick={pickCluster} />}
        <Field label="Name" value={name} onChange={setName} error={errors.name} />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          rows={2}
          hint="Optional. What this application is, for whoever opens the dashboard next."
          spellCheck
        />
        {kind === 'postgres' && (
          <PostgresFields
            form={postgres}
            onChange={setPostgres}
            errors={errors}
            passwordSet={application?.postgres?.passwordSet ?? false}
            forgetPassword={forgetPassword}
            onForgetPassword={setForgetPassword}
          />
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
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
