/**
 * What agents are doing over MCP: the sessions and the recorded tool calls, each fetched once and
 * then kept current by the live stream. Shared by the MCP audit and the dashboard, which show the
 * same activity at different lengths and must never disagree about it.
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from './api.js';

/** "Active" is decided on the server at read time, so an idle agent needs a re-read to be shown idle. */
const SESSIONS_REFRESH_MS = 60_000;

/**
 * The sessions: fetched, re-read every minute, and replaced by the live list whenever one is pushed.
 * @param {object[]|null} live
 */
export function useSessions(live) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      api.listMcpSessions(controller.signal).then(
        (next) => {
          setSessions(next);
          setError(null);
        },
        (err) => {
          if (!controller.signal.aborted) setError(err.message);
        }
      );
    load();
    const timer = setInterval(load, SESSIONS_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (live) setSessions(live);
  }, [live]);

  return { sessions, error };
}

/**
 * The recorded calls for the current filter, with the live ones that arrived after them on top.
 * @param {{sessionId?: string|null, limit: number}} query @param {object[]} liveCalls
 */
export function useCalls({ sessionId = null, limit }, liveCalls) {
  const [recorded, setRecorded] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setRecorded(null);
    api.listMcpCalls({ sessionId: sessionId ?? undefined, limit }, controller.signal).then(
      (next) => {
        setRecorded(next);
        setError(null);
      },
      (err) => {
        if (!controller.signal.aborted) setError(err.message);
      }
    );
    return () => controller.abort();
  }, [sessionId, limit]);

  const calls = useMemo(() => {
    if (!recorded) return null;
    const newest = recorded[0]?.seq ?? -Infinity;
    const fresh = liveCalls.filter(
      (call) => call.seq > newest && (!sessionId || call.sessionId === sessionId)
    );
    return [...fresh, ...recorded].slice(0, limit);
  }, [recorded, liveCalls, sessionId, limit]);

  return { calls, error };
}
