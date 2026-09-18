/**
 * The log tail for the selected application. Autoscroll follows the stream until the user scrolls
 * up — reading back through a stack trace must never be yanked away — and re-engages by itself the
 * moment they return to the bottom, which is the gesture people already expect from a terminal.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';

/** Browser scroll positions are fractional; a few pixels of slack is still "at the bottom". */
const BOTTOM_SLACK_PX = 24;

const STREAMS = [
  ['all', 'All'],
  ['stdout', 'stdout'],
  ['stderr', 'stderr'],
];

const formatTime = (ts) => {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? '' : at.toTimeString().slice(0, 8);
};

/**
 * Which process the tail shows. A tab list because it switches what the one viewport below shows.
 * @param {{processes: object[], source: string, onChange: (processId: string) => void}} props
 */
function SourceTabs({ processes, source, onChange }) {
  const tabs = [['all', 'All'], ...processes.map((process) => [process.id, process.name])];
  return (
    <div className="segmented log-tabs" role="tablist" aria-label="Log source">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={source === id}
          className={`segment${source === id ? ' selected' : ''}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** @param {{stream: string, onChange: (stream: string) => void}} props */
function StreamFilter({ stream, onChange }) {
  return (
    <div className="segmented" role="group" aria-label="Stream">
      {STREAMS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={`segment${stream === value ? ' selected' : ''}`}
          aria-pressed={stream === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * @param {{application: object, logs: object[], onClear: () => void}} props
 */
export default function LogViewer({ application, logs, onClear }) {
  const [processId, setProcessId] = useState('all');
  const [stream, setStream] = useState('all');
  const [following, setFollowing] = useState(true);
  const viewportRef = useRef(null);

  const names = useMemo(
    () => new Map(application.processes.map((p) => [p.id, p.name])),
    [application.processes]
  );
  // The filtered-to process can be deleted out from under the tab bar. Falling back to `all` beats
  // leaving the viewport empty with no tab selected and no way to tell why.
  const source = names.has(processId) ? processId : 'all';
  const visible = logs.filter(
    (line) =>
      (source === 'all' || line.processId === source) &&
      (stream === 'all' || line.stream === stream)
  );

  // Layout effect, not effect: scrolling after paint would show one frame at the old position.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !following) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [visible.length, following, source, stream]);

  const onScroll = () => {
    const viewport = viewportRef.current;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setFollowing(distance <= BOTTOM_SLACK_PX);
  };

  return (
    <section className="panel logs" aria-label="Process output">
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name="terminal" />
          Output
        </h2>
        <SourceTabs processes={application.processes} source={source} onChange={setProcessId} />
        <span className="spacer" />
        <StreamFilter stream={stream} onChange={setStream} />
        <span className="meta">{visible.length.toLocaleString()} lines</span>
        <button
          type="button"
          className="btn small"
          disabled={following}
          onClick={() => setFollowing(true)}
        >
          <Icon name="arrow-down" />
          {following ? 'Following' : 'Jump to latest'}
        </button>
        <button type="button" className="btn small ghost" onClick={onClear}>
          Clear
        </button>
      </div>

      <div
        className="log-viewport"
        ref={viewportRef}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-live="off"
      >
        {visible.length === 0 ? (
          <p className="empty-inline">No output captured yet.</p>
        ) : (
          visible.map((line) => (
            <div key={line.seq} className={`log-line log-${line.stream}`}>
              <span className="log-ts">{formatTime(line.ts)}</span>
              <span className="log-stream">{line.stream === 'stderr' ? 'err' : 'out'}</span>
              {source === 'all' && (
                <span className="log-source">{names.get(line.processId) ?? line.processId}</span>
              )}
              <span className="log-message">{line.message || ' '}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
