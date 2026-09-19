/**
 * The log tail. Autoscroll follows the stream until the user scrolls up — reading back through a
 * stack trace must never be yanked away — and re-engages by itself the moment they return to the
 * bottom, which is the gesture people already expect from a terminal. While they are away the
 * pill over the tail counts what they are missing and takes them back.
 *
 * It shows either the whole application, with a tab per process, or one process on its own: pinned
 * to a process it drops the tab bar, because the drawer it sits in is already titled with the name
 * of the process whose output this is.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import Segmented from './Segmented.jsx';
import { highlight } from '../log-format.js';

/** Browser scroll positions are fractional; a few pixels of slack is still "at the bottom". */
const BOTTOM_SLACK_PX = 24;

const STREAMS = [
  { id: 'all', label: 'All' },
  { id: 'stdout', label: 'stdout' },
  { id: 'stderr', label: 'stderr' },
];

const formatTime = (ts) => {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? '' : at.toTimeString().slice(0, 8);
};

/**
 * One line, painted.
 *
 * Memoised, and that is load-bearing rather than tidy: the tail re-renders on every batch of new
 * lines, and re-tokenising two thousand existing ones each time is the difference between a log
 * that scrolls and one that stutters. It holds because a stored line keeps its identity — the
 * live state appends to the array rather than rebuilding it.
 *
 * @param {{line: object, source: string|null, pretty: boolean}} props `source` is the process
 *   name to show, or null when the tail is already pinned to one process
 */
const LogLine = memo(function LogLine({ line, source, pretty }) {
  const { level, tokens } = highlight(line.message, pretty);
  const classes = ['log-line', `log-${line.stream}`, level && `log-level-${level}`];
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <span className="log-ts">{formatTime(line.ts)}</span>
      <span className="log-stream">{line.stream === 'stderr' ? 'err' : 'out'}</span>
      {source !== null && <span className="log-source">{source}</span>}
      <span className="log-message">
        {/* A blank line still has to take up a line, or the gap it marks in the output is lost. */}
        {tokens.length === 0
          ? line.message || ' '
          : tokens.map((token, index) =>
              // Unpainted text is text, not an element wrapping text. One span saved per token is
              // tens of thousands saved over a full tail.
              token.kind === 'text' ? (
                token.text
              ) : (
                <span key={index} className={`log-t-${token.kind}`}>
                  {token.text}
                </span>
              )
            )}
      </span>
    </div>
  );
});

/**
 * @param {{application: object, logs: object[], onClear: () => void, processId?: string|null}} props
 *   `processId` pins the tail to one process and hides the source tabs; without it the tail spans
 *   the application and the tabs choose
 */
export default function LogViewer({ application, logs, onClear, processId = null }) {
  const [chosen, setChosen] = useState('all');
  const [stream, setStream] = useState('all');
  const [following, setFollowing] = useState(true);
  const [pretty, setPretty] = useState(false);
  // The last line seen at the moment the user left the bottom, so the pill can say how much has
  // arrived since. Null while following.
  const [leftAt, setLeftAt] = useState(null);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  // Mirrors `following` for the resize observer, which is installed once and would otherwise
  // close over the value it had on mount.
  const followingRef = useRef(true);

  const names = useMemo(
    () => new Map(application.processes.map((p) => [p.id, p.name])),
    [application.processes]
  );
  // Pinned wins. Otherwise: the filtered-to process can be deleted out from under the tab bar, and
  // falling back to `all` beats an empty viewport with no tab selected and no way to tell why.
  const source = processId ?? (names.has(chosen) ? chosen : 'all');
  const visible = logs.filter(
    (line) =>
      (source === 'all' || line.processId === source) &&
      (stream === 'all' || line.stream === stream)
  );

  // The newest line on screen. This is what the tail is keyed on rather than how many lines there
  // are: the browser's buffer is capped, so once it is full every new line evicts an old one and
  // the count stops changing — which silently switched autoscroll off exactly when a log was busy
  // enough to need it.
  const newest = visible.length > 0 ? visible[visible.length - 1].seq : 0;
  const behind = leftAt === null ? 0 : visible.reduce((n, l) => (l.seq > leftAt ? n + 1 : n), 0);

  const pin = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  // Layout effect, not effect: scrolling after paint would show one frame at the old position.
  // `pretty` is in here because it changes how tall every line is, so a tail that was at the
  // bottom would otherwise be left halfway up its own output.
  useLayoutEffect(() => {
    followingRef.current = following;
    if (following) pin();
  }, [newest, following, source, stream, pin, pretty]);

  // A new filter is a new tail; the count on the pill would lie if it kept the old baseline.
  useLayoutEffect(() => {
    setLeftAt(null);
  }, [source, stream]);

  // Lines are only laid out as they come into view (see `content-visibility` in the stylesheet),
  // so the tail's true height is not known until it is reached, and it keeps being revised as
  // rows are measured. Re-pinning on that revision is what makes "stuck to the bottom" hold for
  // a wrapped line, a reflowed record, or a font that arrives late.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pin();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [pin]);

  const onScroll = () => {
    const viewport = viewportRef.current;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const atBottom = distance <= BOTTOM_SLACK_PX;
    // Written before the state flips, so the observer above cannot pin the view back down in the
    // same frame the user scrolled away in.
    followingRef.current = atBottom;
    setFollowing(atBottom);
    setLeftAt(atBottom ? null : (previous) => previous ?? newest);
  };

  return (
    <section className="panel logs" aria-label="Process output">
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name="terminal" />
          Output
        </h2>
        {!processId && (
          <Segmented
            className="log-tabs"
            role="tablist"
            label="Log source"
            value={source}
            onChange={setChosen}
            options={[
              { id: 'all', label: 'All' },
              ...application.processes.map((process) => ({ id: process.id, label: process.name })),
            ]}
          />
        )}
        <span className="spacer" />
        <Segmented label="Stream" value={stream} onChange={setStream} options={STREAMS} />
        <button
          type="button"
          className="btn small"
          aria-pressed={pretty}
          title="Print JSON records over several lines, and unescape the traces inside them"
          onClick={() => setPretty((on) => !on)}
        >
          <Icon name="braces" />
          Pretty
        </button>
        <span className="meta">{visible.length.toLocaleString()} lines</span>
        <button type="button" className="btn small ghost" onClick={onClear}>
          Clear
        </button>
      </div>

      <div className="log-body">
        <div
          className="log-viewport"
          ref={viewportRef}
          onScroll={onScroll}
          tabIndex={0}
          role="log"
          aria-live="off"
        >
          <div className="log-lines" ref={contentRef}>
            {visible.length === 0 ? (
              <p className="empty-inline">No output captured yet.</p>
            ) : (
              visible.map((line) => (
                <LogLine
                  key={line.seq}
                  line={line}
                  source={source === 'all' ? names.get(line.processId) ?? line.processId : null}
                  pretty={pretty}
                />
              ))
            )}
          </div>
        </div>

        {/* Only while detached: at the bottom there is nothing to jump to, and its absence is how
            you can tell you are still following. */}
        {!following && (
          <button type="button" className="log-jump" onClick={() => setFollowing(true)}>
            <Icon name="arrow-down" />
            {behind > 0 ? `${behind.toLocaleString()} new` : 'Jump to latest'}
          </button>
        )}
      </div>
    </section>
  );
}
