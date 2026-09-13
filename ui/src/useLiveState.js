/**
 * The dashboard's live state: one fetch of the application list, then one EventSource that keeps
 * that list and the selected application's log tail current. It is a single hook because there is a
 * single stream — status, configuration and log events all arrive on it, and opening a second
 * EventSource per concern would double the server's fan-out for no gain.
 *
 * Every subscription here is torn down for real (`es.close()`, `AbortController.abort()`), which is
 * what makes StrictMode's double-invocation harmless. A "ran once" ref would hide the leak rather
 * than remove it, and would break a legitimate remount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS_URL, listApplications, listPorts, readLogs } from './api.js';

/** The manager's buffer is bounded, so the browser's has to be too. */
const MAX_LOG_LINES = 2_000;
/** Starting an application emits a burst of status events; one refetch for the burst is enough. */
const RELOAD_COALESCE_MS = 150;

const trim = (lines) => (lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines);

const toLine = ({ processId, entry }) => ({
  seq: entry.seq,
  ts: entry.ts,
  stream: entry.stream,
  processId,
  message: entry.message,
});

/**
 * A `log` message is always the batch the broadcaster coalesced: an array of
 * `{applicationId, processId, entry}`. A frame we cannot read must not take the stream down, so an
 * unparseable or unexpected payload is dropped rather than thrown.
 * @param {string} data raw SSE payload
 */
function parseLogBatch(data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];
  return payload.filter((record) => typeof record.entry?.seq === 'number');
}

/**
 * @param {string|null} applicationId the application whose logs to follow — supplied by the route,
 *   so the URL is the single source of truth for what is on screen
 */
export function useLiveState(applicationId) {
  const [applications, setApplications] = useState([]);
  const [logs, setLogs] = useState([]);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState(null);
  // Bumped on every reconnect: the log tail has to be re-read, since anything the manager emitted
  // while the stream was down was never delivered and no later event will repeat it.
  const [streamEpoch, setStreamEpoch] = useState(0);
  // null until the first scan lands, which the table shows as "scanning…" rather than as "no ports".
  const [ports, setPorts] = useState({ ports: null, scannedAt: null, degraded: [] });

  // The route names the application; this is only the loaded copy of it, which is null both before
  // the first fetch lands and when the id in the URL does not exist.
  const selected = applications.find((app) => app.id === applicationId) ?? null;

  const requestRef = useRef(0);
  const viewedRef = useRef(null);
  const lastSeqRef = useRef(0);

  /** @param {AbortSignal} [signal] */
  const reload = useCallback(async (signal) => {
    const ticket = (requestRef.current += 1);
    try {
      const next = await listApplications(signal);
      if (ticket !== requestRef.current) return; // an overtaken response would roll the view back
      setApplications(next);
      setError(null);
    } catch (err) {
      if (!signal?.aborted) setError(err.message);
    }
  }, []);

  /**
   * Ports arrive on the SSE stream from one server-side scan, so this is only the first fill and
   * the explicit Refresh — the dashboard never polls the manager for them.
   *
   * A scan also decides which ports each managed process is shown as holding, and that field rides
   * on the application list — so a fresh scan makes the list stale and it is refetched with it.
   * @param {{force?: boolean}} [options] @param {AbortSignal} [signal]
   */
  const refreshPorts = useCallback(
    async (options = {}, signal) => {
      try {
        setPorts(await listPorts(options, signal));
        await reload(signal);
      } catch (err) {
        if (!signal?.aborted) setError(err.message);
      }
    },
    [reload]
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    refreshPorts({}, controller.signal);
    return () => controller.abort();
  }, [reload, refreshPorts]);

  // Snapshot of the selected application's tail. The stream handler reads `viewedRef` so switching
  // applications never reopens the EventSource.
  useEffect(() => {
    viewedRef.current = applicationId;
    lastSeqRef.current = 0;
    setLogs([]);
    if (!applicationId) return undefined;

    const controller = new AbortController();
    readLogs({ applicationId, limit: MAX_LOG_LINES }, controller.signal)
      .then(({ entries, nextSeq }) => {
        lastSeqRef.current = Math.max(lastSeqRef.current, nextSeq - 1);
        // Lines that streamed in while this request was open are newer than the snapshot; keep them.
        setLogs((streamed) => trim([...entries, ...streamed.filter((l) => l.seq >= nextSeq)]));
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [applicationId, streamEpoch]);

  const appendLogs = useCallback((records) => {
    const fresh = records.filter(
      (r) => r.applicationId === viewedRef.current && r.entry.seq > lastSeqRef.current
    );
    if (!fresh.length) return;
    lastSeqRef.current = fresh.reduce((max, r) => Math.max(max, r.entry.seq), lastSeqRef.current);
    setLogs((prev) => trim([...prev, ...fresh.map(toLine)]));
  }, []);

  useEffect(() => {
    const source = new EventSource(EVENTS_URL);
    let coalesce = null;
    let opened = false;

    // Application status and the per-status counts are derived by the manager; refetching keeps one
    // definition of them instead of re-deriving the precedence rules in the browser.
    const scheduleReload = () => {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        reload();
      }, RELOAD_COALESCE_MS);
    };

    source.addEventListener('open', () => {
      setConnection('live');
      // A reconnect means events were missed while the stream was down: the list and the log tail
      // both have to be re-read, because nothing replays them.
      if (opened) {
        reload();
        setStreamEpoch((epoch) => epoch + 1);
      }
      opened = true;
    });
    // EventSource retries by itself — except when it has given up for good (a non-2xx response, or
    // a body that is not text/event-stream), and reporting that as "reconnecting" would be a lie.
    source.addEventListener('error', () => {
      setConnection(source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    });
    source.addEventListener('status', scheduleReload);
    source.addEventListener('applications', scheduleReload);
    source.addEventListener('log', (event) => appendLogs(parseLogBatch(event.data)));
    source.addEventListener('ports', (event) => {
      // An unreadable frame is dropped rather than thrown: one bad payload must not take down the
      // stream that also carries status and logs.
      try {
        setPorts(JSON.parse(event.data));
      } catch {
        return; // keep the previous list
      }
      // The per-process `ports` field comes from the same scan, so the list is now behind.
      scheduleReload();
    });

    return () => {
      clearTimeout(coalesce);
      source.close();
    };
  }, [reload, appendLogs]);

  const clearLogs = useCallback(() => setLogs([]), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    applications,
    selected,
    logs,
    connection,
    error,
    dismissError,
    reload,
    clearLogs,
    ports,
    refreshPorts,
  };
}
