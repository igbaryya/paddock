/**
 * The log tail for the selected application. Autoscroll follows the stream until the user scrolls
 * up — reading back through a stack trace must never be yanked away — and re-engages by itself the
 * moment they return to the bottom, which is the gesture people already expect from a terminal.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';

/** Browser scroll positions are fractional; a few pixels of slack is still "at the bottom". */
const BOTTOM_SLACK_PX = 24;

const formatTime = (ts) => {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? '' : at.toTimeString().slice(0, 8);
};

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
    <section className="logs" aria-label="Process output">
      <div className="log-bar">
        <Icon name="terminal" className="log-mark" />
        <div className="tabs" role="tablist" aria-label="Log source">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'all'}
            className={`tab${source === 'all' ? ' selected' : ''}`}
            onClick={() => setProcessId('all')}
          >
            All
          </button>
          {application.processes.map((process) => (
            <button
              key={process.id}
              type="button"
              role="tab"
              aria-selected={source === process.id}
              className={`tab${source === process.id ? ' selected' : ''}`}
              onClick={() => setProcessId(process.id)}
            >
              {process.name}
            </button>
          ))}
        </div>

        <label className="log-filter">
          Stream
          <select value={stream} onChange={(event) => setStream(event.target.value)}>
            <option value="all">all</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
        </label>

        <span className="meta">{visible.length} lines</span>
        <button
          type="button"
          className="btn small"
          disabled={following}
          onClick={() => setFollowing(true)}
        >
          {following ? 'Following' : 'Jump to latest'}
        </button>
        <button type="button" className="btn small ghost" onClick={onClear}>
          Clear view
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
              <span className="log-message">{line.message || ' '}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
