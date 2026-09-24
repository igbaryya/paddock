/**
 * The history under a process's changes: one row per commit, with the graph drawn beside it the way
 * editors draw it — a column per line of development, a dot per commit, and the lines that branch
 * off and merge back in between.
 *
 * The layout is `layoutGraph`'s; this only draws it. Each row is its own small SVG so the list is an
 * ordinary list (selectable text, native scrolling), and a row's lines meet the next row's exactly
 * because both are drawn from the same column positions. Monochrome by design: on this dashboard
 * colour means state, and a lane is not a state. Only HEAD's dot takes the accent.
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { layoutGraph } from '../git-graph.js';
import { DrawerEmpty, DrawerSection } from './Drawer.jsx';

const LANE = 12;
const ROW = 24;
const MID = ROW / 2;

const x = (column) => column * LANE + LANE / 2;

/** A straight line within a column, or an S-curve between two. */
const segment = (fromColumn, fromY, toColumn, toY) =>
  fromColumn === toColumn
    ? `M${x(fromColumn)} ${fromY}V${toY}`
    : `M${x(fromColumn)} ${fromY}C${x(fromColumn)} ${(fromY + toY) / 2} ${x(toColumn)} ${(fromY + toY) / 2} ${x(toColumn)} ${toY}`;

/** @param {{row: ReturnType<typeof layoutGraph>[number], head: boolean}} props */
function GraphCell({ row, head }) {
  const paths = [];
  row.before.forEach((hash, column) => {
    if (hash == null) return;
    // A line heading for this commit ends at its dot; any other passes straight through.
    paths.push(segment(column, 0, hash === row.hash ? row.column : column, MID));
  });
  row.after.forEach((hash, column) => {
    if (hash == null) return;
    const fromDot = row.edges.includes(column);
    paths.push(segment(fromDot ? row.column : column, MID, column, ROW));
  });
  return (
    <svg className="scm-graph" width={row.width * LANE} height={ROW} aria-hidden="true">
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
      <circle className={head ? 'head' : ''} cx={x(row.column)} cy={MID} r={3.5} />
    </svg>
  );
}

const formatDay = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString();
};

/** @param {{applicationId: string, processId: string}} props */
export default function GitHistory({ applicationId, processId }) {
  const [commits, setCommits] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getGitLog(applicationId, processId, controller.signal).then(
      ({ commits: next }) => setCommits(next),
      (err) => {
        if (!controller.signal.aborted) setError(err.message);
      }
    );
    return () => controller.abort();
  }, [applicationId, processId]);

  const rows = useMemo(() => (commits ? layoutGraph(commits) : []), [commits]);

  let body;
  if (error) body = <DrawerEmpty icon="alert">{error}</DrawerEmpty>;
  else if (!commits) body = <p className="empty-inline" role="status">Loading…</p>;
  else if (!commits.length) body = <DrawerEmpty>No commits yet.</DrawerEmpty>;
  else {
    body = (
      <ol className="scm-history">
        {commits.map((commit, index) => (
          <li key={commit.hash} className="scm-commit">
            <GraphCell row={rows[index]} head={commit.refs.some((ref) => ref.startsWith('HEAD'))} />
            <span className="scm-commit-subject" title={`${commit.hash}\n${commit.author}`}>
              {commit.subject}
            </span>
            {commit.refs.map((ref) => (
              <span key={ref} className="scm-ref">
                {ref.replace(/^HEAD -> /, '').replace(/^tag: /, '')}
              </span>
            ))}
            <span className="scm-commit-meta">{formatDay(commit.at)}</span>
          </li>
        ))}
      </ol>
    );
  }

  return <DrawerSection title="History">{body}</DrawerSection>;
}
