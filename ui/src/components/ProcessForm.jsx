/**
 * Add or edit a process: where its repository is, what command starts it, and the environment that
 * command runs in. The rules checked here are the manager's rules, restated so a typo is caught
 * before a round trip — the manager re-checks all of them (and the ones only it can check, like
 * whether the directory actually exists) and its message wins whenever it disagrees.
 *
 * Three of the fields can fill themselves in, all from one question: what is in the directory the
 * command will run in. The paths have a browser, the command is offered the package.json scripts
 * found there, and the environment is offered the .env files sitting next to them. Every one of
 * those is a suggestion the user then edits — nothing is written into the form without a click.
 */
import { useState } from 'react';
import Modal from './Modal.jsx';
import Field, { nameError } from './Field.jsx';
import PathField, { isAbsolute } from './PathField.jsx';
import { useInspection } from '../useInspection.js';

const MAX_COMMAND = 2_000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Enough normalisation to compare two paths: separators unified, trailing separators dropped. */
const normalize = (value) => value.trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1');

const isInside = (child, parent) => {
  const [inner, outer] = [normalize(child), normalize(parent)];
  return inner === outer || inner.startsWith(`${outer}/`);
};

// React keys for the env rows, so editing one does not re-key the list and steal focus. A counter
// is right here where an entity id would not be: these never leave the browser.
let rowKey = 0;
const envRow = (key = '', value = '') => ({ id: `row-${(rowKey += 1)}`, key, value });

const envRowsOf = (env) => Object.entries(env ?? {}).map(([key, value]) => envRow(key, value));

const envOf = (rows) =>
  Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function envError(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.value.trim()) return 'Every environment value needs a name';
      continue;
    }
    if (!ENV_KEY.test(key)) return `"${key}" is not a valid environment variable name`;
    if (seen.has(key)) return `"${key}" is set twice`;
    if (key === 'PATH' && !row.value.trim()) return 'PATH cannot be set to an empty value';
    seen.add(key);
  }
  return null;
}

function validate({ name, repositoryPath, command, workingDirectory, rows }) {
  const found = { name: nameError(name), env: envError(rows) };

  if (!repositoryPath.trim()) found.repositoryPath = 'Repository path is required';
  else if (!isAbsolute(repositoryPath.trim())) found.repositoryPath = 'Repository path must be absolute';

  if (!command.trim()) found.command = 'Command is required';
  else if (command.trim().length > MAX_COMMAND) {
    found.command = `Command must be ${MAX_COMMAND} characters or fewer`;
  }

  const cwd = workingDirectory.trim();
  if (cwd && !isAbsolute(cwd)) found.workingDirectory = 'Working directory must be absolute';
  else if (cwd && !found.repositoryPath && !isInside(cwd, repositoryPath)) {
    found.workingDirectory = 'Working directory must be inside the repository path';
  }

  return Object.fromEntries(Object.entries(found).filter(([, message]) => message));
}

/**
 * Variables from a file, added to the rows already on the form. A key the form already carries keeps
 * the value it has: an override the user has typed is the reason they opened this form, and a second
 * click on Load must not be what throws it away. The blank row a fresh form starts with is dropped
 * rather than left floating above the loaded ones.
 * @returns {{rows: object[], added: number}}
 */
function mergeEnv(rows, variables) {
  const present = new Set(rows.map((row) => row.key.trim()).filter(Boolean));
  const kept = rows.filter((row) => row.key.trim() || row.value.trim());
  const added = variables.filter((variable) => !present.has(variable.key));
  return { rows: [...kept, ...added.map((v) => envRow(v.key, v.value))], added: added.length };
}

/** Exactly what the click did: "nothing was added" and "nothing happened" look identical otherwise. */
function loadNotice(file, added) {
  const parts = [`${added} loaded`];
  const already = file.variables.length - added;
  if (already) parts.push(`${already} already set here and left alone`);
  if (file.skipped.length) parts.push(`${file.skipped.length} skipped (not valid variable names)`);
  if (file.truncated) parts.push('the file holds more than this form will read');
  return `${file.name}: ${parts.join(', ')}.`;
}

/**
 * The .env files found next to the command. One that cannot be read is named rather than dropped: a
 * file the form silently skipped is indistinguishable from a file with nothing in it.
 * @param {{files: object[]|undefined, notice: string|null, onLoad: (file: object) => void}} props
 */
function EnvFiles({ files, notice, onLoad }) {
  if (!files?.length) return null;
  const readable = files.filter((file) => !file.error);
  const unreadable = files.filter((file) => file.error);

  return (
    <div className="suggestions">
      {readable.length > 0 && (
        <div className="chips">
          {readable.map((file) => (
            <button
              key={file.path}
              type="button"
              className="chip"
              onClick={() => onLoad(file)}
              title={`Load ${file.variables.length} variables from ${file.path}`}
            >
              {file.name}
              <span className="chip-count">{file.variables.length}</span>
            </button>
          ))}
        </div>
      )}
      {unreadable.map((file) => (
        <p className="hint" key={file.path}>
          {file.name} could not be read: {file.error}
        </p>
      ))}
      {notice && <p className="hint">{notice}</p>}
    </div>
  );
}

/**
 * @param {{rows: object[], onChange: (rows: object[]) => void, error?: string,
 *          children?: React.ReactNode}} props
 */
function EnvRows({ rows, onChange, error, children }) {
  const patch = (id, field, value) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));

  return (
    <fieldset className="field env">
      <legend>Environment</legend>
      <p className="hint">Merged over the manager's own environment when the command is spawned.</p>
      {children}
      {rows.map((row) => (
        <div className="env-row" key={row.id}>
          <input
            type="text"
            value={row.key}
            placeholder="NAME"
            spellCheck={false}
            aria-label="Variable name"
            onChange={(event) => patch(row.id, 'key', event.target.value)}
          />
          <input
            type="text"
            value={row.value}
            placeholder="value"
            spellCheck={false}
            aria-label={`Value for ${row.key || 'the new variable'}`}
            onChange={(event) => patch(row.id, 'value', event.target.value)}
          />
          <button
            type="button"
            className="btn small ghost"
            aria-label={`Remove ${row.key || 'empty variable'}`}
            onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn small"
        onClick={() => onChange([...rows, envRow()])}
      >
        Add variable
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The scripts the chosen directory actually declares, one click each. What gets filled in is the
 * long form — `pnpm run dev`, never `pnpm dev` — because a script named after a built-in subcommand
 * is the one case the shorthand silently runs something else.
 * @param {{loading: boolean, inspection: object|null, onPick: (command: string) => void}} props
 */
function ScriptSuggestions({ loading, inspection, onPick }) {
  if (loading) return <p className="hint">Reading the directory…</p>;
  if (!inspection) return null;
  if (!inspection.scripts.length) {
    return <p className="hint">No package.json scripts in this directory.</p>;
  }

  return (
    <div className="suggestions">
      <p className="hint">
        {inspection.packageName ?? 'package.json'} — {inspection.packageManager}
      </p>
      <div className="chips">
        {inspection.scripts.map((script) => (
          <button
            key={script.name}
            type="button"
            className="chip mono"
            title={script.script}
            onClick={() => onPick(script.command)}
          >
            {script.command}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * @param {{process: object|null, onSubmit: (values: object) => Promise<void>,
 *          onClose: () => void}} props
 */
export default function ProcessForm({ process, onSubmit, onClose }) {
  const [name, setName] = useState(process?.name ?? '');
  const [repositoryPath, setRepositoryPath] = useState(process?.repositoryPath ?? '');
  const [command, setCommand] = useState(process?.command ?? '');
  // The manager reports the *effective* working directory; showing it back as an explicit value
  // would turn "unset" into a setting the user never made.
  const [workingDirectory, setWorkingDirectory] = useState(
    process && process.workingDirectory !== process.repositoryPath ? process.workingDirectory : ''
  );
  const [rows, setRows] = useState(() => envRowsOf(process?.env));
  const [enabled, setEnabled] = useState(process?.enabled ?? true);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [envNotice, setEnvNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  // The same resolution the manager makes at spawn time, so the scripts and the .env files offered
  // here are the ones the command will actually see — which in a monorepo is the whole point.
  const target = workingDirectory.trim() || repositoryPath.trim();
  const { loading, inspection } = useInspection(isAbsolute(target) ? target : null);

  const loadEnvFile = (file) => {
    const merged = mergeEnv(rows, file.variables);
    setRows(merged.rows);
    setEnvNotice(loadNotice(file, merged.added));
  };

  const submit = async (event) => {
    event.preventDefault();
    const invalid = validate({ name, repositoryPath, command, workingDirectory, rows });
    setErrors(invalid);
    if (Object.keys(invalid).length) return;

    setServerError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        repositoryPath: repositoryPath.trim(),
        command: command.trim(),
        workingDirectory: workingDirectory.trim() || null,
        env: envOf(rows),
        enabled,
      });
    } catch (err) {
      setServerError(err.message); // the manager is authoritative; show exactly what it said
      setSaving(false);
    }
  };

  return (
    <Modal title={process ? `Edit ${process.name}` : 'Add process'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Name" value={name} onChange={setName} error={errors.name} />
        <PathField
          label="Repository path"
          value={repositoryPath}
          onChange={setRepositoryPath}
          error={errors.repositoryPath}
          placeholder="/path/to/project"
          hint="Absolute path to the checkout. The command runs here unless you set a working directory."
          start=""
        />
        <div className="field-group">
          <Field
            label="Command"
            value={command}
            onChange={setCommand}
            rows={2}
            error={errors.command}
            placeholder="npm run dev"
            hint="Run through your shell, so pipes, && and env prefixes all work."
            mono
          />
          <ScriptSuggestions loading={loading} inspection={inspection} onPick={setCommand} />
        </div>
        <PathField
          label="Working directory"
          value={workingDirectory}
          onChange={setWorkingDirectory}
          error={errors.workingDirectory}
          hint="Optional. Must be inside the repository path."
          start={repositoryPath.trim()}
        />
        <EnvRows rows={rows} onChange={setRows} error={errors.env}>
          <EnvFiles files={inspection?.envFiles} notice={envNotice} onLoad={loadEnvFile} />
        </EnvRows>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled &mdash; disabled processes are skipped when the application starts
        </label>

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
