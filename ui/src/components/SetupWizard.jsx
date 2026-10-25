/**
 * First-run setup: Paddock's mark, MCP, and a first application. Each is one step and each can be
 * skipped, because nothing else in Paddock waits on any of them. It opens by itself only on a fresh
 * install (see service.getSetup) and from Settings after that. Finishing and skipping end it the same
 * way: the manager records it, so it does not open again in this browser or another.
 *
 * It replaced an MCP-only install dialog. A fresh install has usually installed MCP by itself by the
 * time this opens (PADDOCK_MCP_AUTO_CONFIGURE), so that step mostly hands over the URL and the
 * one-click agent setup; the port is asked for only when the listener is not up.
 *
 * Every failure is shown in the step that hit it, never as the shell's toast: the toast sits under
 * this dialog's scrim, where it cannot be read.
 */
import { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import { folderName } from '../format.js';
import { useInspection } from '../useInspection.js';
import Field from './Field.jsx';
import Icon from './Icon.jsx';
import LogoPicker from './LogoPicker.jsx';
import McpClients from './McpClients.jsx';
import { McpUrlRow } from './McpSettings.jsx';
import Modal from './Modal.jsx';
import PathField, { isAbsolute } from './PathField.jsx';
import { validateProcess } from './ProcessForm.jsx';
import ScriptSuggestions from './ScriptSuggestions.jsx';
import SettingsGroup from './SettingsGroup.jsx';
import Switch from './Switch.jsx';

const STEPS = [
  { id: 'logo', label: 'Your logo' },
  { id: 'mcp', label: 'MCP' },
  { id: 'application', label: 'First application' },
];

/** The manager's own default (mcp-preferences.js), offered when the listener never had a port. */
const DEFAULT_MCP_PORT = 4600;

/** @param {{current: number}} props */
function StepList({ current }) {
  return (
    <ol className="setup-steps">
      {STEPS.map((step, index) => (
        <li
          key={step.id}
          className={`setup-step${index < current ? ' done' : ''}`}
          aria-current={index === current ? 'step' : undefined}
          tabIndex={index === current ? -1 : undefined}
        >
          <span className="setup-step-index">
            {index < current ? <Icon name="check" size={12} /> : index + 1}
          </span>
          <span className="setup-step-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Skip sits on the far side, apart from the step's own buttons, where Cancel sits on a form.
 * @param {{busy: boolean, onSkip: () => void, onBack?: () => void, children: React.ReactNode}} props
 *   `children` is the step's primary action
 */
function StepActions({ busy, onSkip, onBack, children }) {
  return (
    <div className="form-actions">
      <button type="button" className="btn ghost setup-skip" disabled={busy} onClick={onSkip}>
        Skip setup
      </button>
      {onBack && (
        <button type="button" className="btn" disabled={busy} onClick={onBack}>
          Back
        </button>
      )}
      {children}
    </div>
  );
}

function LogoStep() {
  return (
    <>
      <p className="setup-lead">
        Paddock runs your local applications and hands the same controls to your agents. Three short
        steps, each one optional — first, the mark this dashboard shows.
      </p>
      <SettingsGroup title="Logo" note="Shown in the sidebar and the browser tab. Change it any time in Settings → General.">
        <LogoPicker />
      </SettingsGroup>
    </>
  );
}

/**
 * The port for a listener that is not up: never installed, or installed on a port it could not bind
 * — which is why the reason it did not start is shown before anything is typed.
 * @param {{mcp: object, onInstalled: (view: object) => void}} props `mcp` is a view of /api/mcp
 */
function McpPortForm({ mcp, onInstalled }) {
  const [port, setPort] = useState(String(mcp.port ?? DEFAULT_MCP_PORT));
  const [error, setError] = useState(mcp.lastError ? `MCP could not start: ${mcp.lastError.message}` : null);
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      setError('Port must be a whole number from 1024 to 65535.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      onInstalled(await api.configureMcp({ port: value }));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <p className="setup-lead">
        Agents connect to Paddock over MCP, on a port of its own, separate from this dashboard. Choose
        one that is free on this machine — the default is usually fine.
      </p>
      <Field
        label="MCP port"
        type="number"
        value={port}
        onChange={setPort}
        error={error}
        action={
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Starting…' : 'Install and start MCP'}
          </button>
        }
      />
    </form>
  );
}

/** Up: the URL and the one-click setup for the agents on this machine. Not up: the port to use. */
function McpStep() {
  const [mcp, setMcp] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getMcp(controller.signal).then(setMcp, (err) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
  }, []);

  if (!mcp) {
    return error ? (
      <p className="notice danger" role="alert">
        <Icon name="alert" />
        <span>{error}</span>
      </p>
    ) : (
      <p className="empty-inline" role="status">
        Loading…
      </p>
    );
  }
  if (!mcp.running) return <McpPortForm mcp={mcp} onInstalled={setMcp} />;
  return (
    <>
      <p className="setup-lead">
        MCP is running. Agents reach Paddock at this URL — or add it to Cursor or Claude Code in one
        click, below.
      </p>
      <SettingsGroup title="Listener" note="Change the port any time in Settings → MCP.">
        <McpUrlRow url={mcp.url} />
      </SettingsGroup>
      <McpClients url={mcp.url} />
    </>
  );
}

/**
 * One repository and the command that starts it: the application and its first process, made in one
 * go. The name follows the folder until it is typed into.
 * @param {{actions: object, onCreate: (values: object, start: boolean) => Promise<void>}} props
 *   `actions` is the wizard's StepActions, which this step puts inside its own form
 */
function ApplicationStep({ actions, onCreate }) {
  const [repositoryPath, setRepositoryPath] = useState('');
  // null while it follows the folder; once typed, it stays whatever folder is picked after it.
  const [typedName, setTypedName] = useState(null);
  const [command, setCommand] = useState('');
  const [start, setStart] = useState(true);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);

  const directory = repositoryPath.trim();
  const name = typedName ?? folderName(directory);
  const { loading, inspection } = useInspection(isAbsolute(directory) ? directory : null);

  const submit = async (event) => {
    event.preventDefault();
    const invalid = validateProcess({ name, repositoryPath, command, workingDirectory: '', rows: [] });
    setErrors(invalid);
    if (Object.keys(invalid).length) return;

    setServerError(null);
    setSaving(true);
    try {
      await onCreate({ name: name.trim(), repositoryPath: directory, command: command.trim() }, start);
    } catch (err) {
      setServerError(err.message); // the manager is authoritative; show exactly what it said
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <p className="setup-lead">
        A repository and the command that starts it. More processes, and PostgreSQL servers, are added
        from the application's own page.
      </p>
      <div className="form-section">
        <PathField
          label="Repository path"
          value={repositoryPath}
          onChange={setRepositoryPath}
          error={errors.repositoryPath}
          placeholder="/path/to/project"
          start=""
        />
        <Field
          label="Name"
          value={name}
          onChange={setTypedName}
          error={errors.name}
          hint="The folder's name until you type one."
        />
      </div>

      <div className="form-section">
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
        <div className="switch-row">
          <div className="row-text">
            <span className="row-title">Start it now</span>
            <span className="row-sub">Its page opens either way.</span>
          </div>
          <Switch checked={start} label="Start it now" onChange={setStart} />
        </div>
      </div>

      {serverError && (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      )}
      <StepActions {...actions} busy={actions.busy || saving}>
        <button type="submit" className="btn primary" disabled={actions.busy || saving}>
          {saving ? 'Creating…' : 'Create and finish'}
        </button>
      </StepActions>
    </form>
  );
}

/**
 * @param {{onFinish: () => Promise<void>,
 *          onCreateApplication: (values: {name: string, repositoryPath: string, command: string},
 *                                start: boolean) => Promise<void>}} props
 *   both reject with the manager's own words, which the wizard shows where they happened
 */
export default function SetupWizard({ onFinish, onCreateApplication }) {
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState(null);
  const bodyRef = useRef(null);
  const shownRef = useRef(index);
  const step = STEPS[index];

  // A new step is announced from its place in the list, the way the dialog's title is on open. Not
  // its first control: while a step is still loading that is Skip, one Enter away from ending setup.
  useEffect(() => {
    if (shownRef.current === index) return;
    shownRef.current = index;
    bodyRef.current.querySelector('.setup-step[aria-current="step"]')?.focus();
  }, [index]);

  const finish = async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await onFinish();
    } catch (err) {
      setFinishError(err.message);
      setFinishing(false);
    }
  };

  const actions = {
    busy: finishing,
    onSkip: finish,
    onBack: index > 0 ? () => setIndex(index - 1) : undefined,
  };

  return (
    <Modal title="Set up Paddock" onClose={finish} persistent>
      <div className="setup" ref={bodyRef}>
        <StepList current={index} />
        {step.id === 'logo' && <LogoStep />}
        {step.id === 'mcp' && <McpStep />}
        {finishError && (
          <p className="form-error" role="alert">
            {finishError}
          </p>
        )}
        {step.id === 'application' ? (
          <ApplicationStep actions={actions} onCreate={onCreateApplication} />
        ) : (
          <StepActions {...actions}>
            <button type="button" className="btn primary" disabled={finishing} onClick={() => setIndex(index + 1)}>
              Next
            </button>
          </StepActions>
        )}
      </div>
    </Modal>
  );
}
