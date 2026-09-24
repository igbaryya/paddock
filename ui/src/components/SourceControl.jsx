/**
 * A process's repository, the way an editor's Source Control view shows it: the branch and how far
 * it is from its upstream, then what is changed — conflicts, staged, unstaged, untracked — with any
 * file opening its diff in place, and the history underneath.
 *
 * Read-only on purpose. Staging and committing change the user's repository, and a side panel in a
 * process manager is not where that should be one misclick away.
 *
 * It re-reads the status every few seconds while the tab is open and the window is visible, so an
 * edit made in the editor shows up here without a Refresh. Nothing polls once the tab is closed.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import { DrawerEmpty, DrawerSection } from './Drawer.jsx';
import GitHistory from './GitHistory.jsx';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';

const POLL_MS = 5_000;
/** A diff is read, not scrolled through for minutes: past this many lines, the rest is summarized. */
const MAX_DIFF_LINES = 2_000;

const STATUS_WORDS = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Untracked',
  '!': 'Conflict',
};

/**
 * The status, kept current while mounted and visible.
 * @param {string} applicationId @param {string} processId
 */
function useGitStatus(applicationId, processId) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [epoch, setEpoch] = useState(0);

  const refresh = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      if (document.hidden) return;
      api.getGitStatus(applicationId, processId, controller.signal).then(
        (next) => {
          setStatus(next);
          setError(null);
        },
        (err) => {
          if (!controller.signal.aborted) setError(err.message);
        }
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [applicationId, processId, epoch]);

  return { status, error, refresh };
}

/** @param {{status: object, onRefresh: () => void}} props */
function BranchLine({ status, onRefresh }) {
  const name = status.detached ? 'Detached HEAD' : status.branch ?? 'No branch yet';
  return (
    <div className="scm-branch">
      <Icon name="branch" size={14} />
      <span className="scm-branch-name" title={status.root}>
        {name}
      </span>
      {status.upstream && (
        <span className="scm-branch-sync" title={`Compared with ${status.upstream}`}>
          ↑{status.ahead} ↓{status.behind}
        </span>
      )}
      <span className="spacer" />
      <IconButton icon="refresh" label="Refresh source control" className="small ghost" onClick={onRefresh} />
    </div>
  );
}

/** @param {{diff: string, truncated: boolean, binary: boolean}} props */
function DiffView({ diff, truncated, binary }) {
  if (binary) return <p className="scm-diff-note">Binary file — no text diff to show.</p>;
  const lines = diff.split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div className="scm-diff">
      <pre>
        {shown.map((line, index) => (
          <span key={index} className={`scm-diff-line ${diffLineKind(line)}`}>
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
      {(truncated || hidden > 0) && (
        <p className="scm-diff-note">This diff is too large to show in full; the rest is cut.</p>
      )}
    </div>
  );
}

/** @param {string} line */
function diffLineKind(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}

/**
 * One changed file; opening it fetches its diff.
 * @param {{applicationId: string, processId: string, file: object, side: string, open: boolean,
 *          onToggle: () => void}} props
 */
function ChangeRow({ applicationId, processId, file, side, open, onToggle }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const letter = side === 'untracked' ? 'U' : side === 'conflicted' ? '!' : file.status;
  const slash = file.path.lastIndexOf('/');

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const query = { path: file.path, staged: side === 'staged', untracked: side === 'untracked' };
    api.getGitDiff(applicationId, processId, query, controller.signal).then(setDiff, (err) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
  }, [open, applicationId, processId, file.path, side]);

  return (
    <li className="scm-file">
      <button type="button" className="scm-file-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevron" size={12} className="scm-file-chevron" />
        <span className="scm-file-name" title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.path.slice(slash + 1)}
        </span>
        <span className="scm-file-dir">{file.path.slice(0, slash + 1)}</span>
        <span className={`scm-letter status-${letter}`} title={STATUS_WORDS[letter]}>
          {letter}
        </span>
      </button>
      {open && (error ? <p className="scm-diff-note danger">{error}</p> : diff && <DiffView {...diff} />)}
    </li>
  );
}

/**
 * @param {{title: string, side: string, files: object[], openKey: string|null,
 *          onToggle: (key: string) => void, applicationId: string, processId: string}} props
 */
function ChangeGroup({ title, side, files, openKey, onToggle, applicationId, processId }) {
  if (!files.length) return null;
  return (
    <DrawerSection title={`${title} · ${files.length}`}>
      <ul className="scm-files">
        {files.map((file) => {
          const key = `${side}:${file.path}`;
          return (
            <ChangeRow
              key={key}
              applicationId={applicationId}
              processId={processId}
              file={file}
              side={side}
              open={openKey === key}
              onToggle={() => onToggle(key)}
            />
          );
        })}
      </ul>
    </DrawerSection>
  );
}

const GROUPS = [
  { side: 'conflicted', title: 'Merge conflicts' },
  { side: 'staged', title: 'Staged changes' },
  { side: 'unstaged', title: 'Changes' },
  { side: 'untracked', title: 'Untracked' },
];

/** @param {{applicationId: string, processId: string}} props */
export default function SourceControl({ applicationId, processId }) {
  const { status, error, refresh } = useGitStatus(applicationId, processId);
  const [openKey, setOpenKey] = useState(null);

  if (!status) {
    return error ? (
      <DrawerEmpty icon="alert">{error}</DrawerEmpty>
    ) : (
      <p className="empty-inline" role="status">
        Loading…
      </p>
    );
  }
  if (!status.repo) {
    return <DrawerEmpty icon="branch">This process's directory is not in a git repository.</DrawerEmpty>;
  }

  const clean = GROUPS.every(({ side }) => status[side].length === 0);
  return (
    <div className="scm">
      <BranchLine status={status} onRefresh={refresh} />
      {error && <p className="scm-diff-note danger">Could not refresh: {error}</p>}
      {clean && <DrawerEmpty icon="check">Nothing to commit — the working tree is clean.</DrawerEmpty>}
      {GROUPS.map(({ side, title }) => (
        <ChangeGroup
          key={side}
          title={title}
          side={side}
          files={status[side]}
          openKey={openKey}
          onToggle={(key) => setOpenKey((current) => (current === key ? null : key))}
          applicationId={applicationId}
          processId={processId}
        />
      ))}
      <GitHistory applicationId={applicationId} processId={processId} />
    </div>
  );
}
