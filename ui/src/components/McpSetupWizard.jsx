/**
 * First-run installation for MCP: pick the port agents will connect on. Nothing starts until this
 * completes — the listener is brought up by the configure call at the end.
 */
import { useState } from 'react';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';

/**
 * @param {{defaultPort?: number, busy?: boolean,
 *          onSubmit: (port: number) => Promise<void>}} props
 */
export default function McpSetupWizard({ defaultPort = 4600, busy = false, onSubmit }) {
  const [port, setPort] = useState(String(defaultPort));
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      setError('Port must be a whole number from 1024 to 65535.');
      return;
    }
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal title="Install MCP" onClose={() => {}} persistent>
      <form className="mcp-wizard" onSubmit={submit}>
        <p className="hint">
          Agents connect to MCP on its own port, separate from this dashboard. Choose a port that is
          free on this machine — the default is usually fine.
        </p>
        <label className="field">
          <span className="field-label">MCP port</span>
          <input
            className="field-input"
            type="number"
            min={1024}
            max={65535}
            step={1}
            value={port}
            disabled={busy}
            onChange={(event) => setPort(event.target.value)}
            autoFocus
          />
        </label>
        {error && (
          <p className="notice danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            Install and start MCP
          </button>
        </div>
      </form>
    </Modal>
  );
}
