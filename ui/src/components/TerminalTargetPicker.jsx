/**
 * Which directory a new terminal opens in, when an application has more than one.
 *
 * An application is several repositories, so "open a terminal" has no single answer the way it does
 * in a single-folder editor — the same question VS Code asks when a workspace has more than one
 * root. It is only ever asked when there is something to ask: the panel opens a terminal without
 * showing this whenever the application resolves to one directory.
 *
 * The choice is a process, not a path. What directory that process runs in is the manager's to
 * resolve, and the name is what the user recognises — nobody picks a repository by its absolute
 * path when they could pick it by the thing running there.
 */
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';

/**
 * @param {{targets: {processId: string, processName: string, cwd: string}[],
 *          onPick: (processId: string) => void, onClose: () => void}} props
 */
export default function TerminalTargetPicker({ targets, onPick, onClose }) {
  return (
    <Modal title="Open a terminal in" onClose={onClose}>
      <div className="form-section">
        <ul className="picker-list">
          {targets.map((target) => (
            <li key={target.processId}>
              <button
                type="button"
                className="picker-entry terminal-target"
                onClick={() => onPick(target.processId)}
              >
                <span className="cluster-meta">
                  <Icon name="terminal" />
                  {target.processName}
                </span>
                <span className="cluster-path">{target.cwd}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
