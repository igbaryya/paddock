/**
 * Which agents are connected over MCP, and every tool call they made — the audit the owner reads to
 * answer "what did the agent just do to my stack".
 *
 * The page fetches what is already recorded, then the live stream adds to it: sessions are replaced
 * whenever one connects, identifies itself or leaves, and each call arrives as it is made. A call
 * opens to its arguments and its error, so "it restarted the backend" can be checked against what it
 * was actually asked to do. Nothing here can change or clear the audit.
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { formatUptime } from '../format.js';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import SettingsGroup from './SettingsGroup.jsx';
import StatusDot from './StatusDot.jsx';

const CALL_LIMIT = 200;
/** "Active" is decided on the server at read time, so an idle agent needs a re-read to be shown idle. */
const SESSIONS_REFRESH_MS = 60_000;

const clientName = (client) => (client ? `${client.name} ${client.version}` : 'Unidentified client');

const ago = (iso, now) => `${formatUptime(now - Date.parse(iso))} ago`;

const formatTime = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleTimeString();
};

/**
 * The sessions: fetched, re-read every minute, and replaced by the live list whenever one is pushed.
 * @param {object[]|null} live
 */
function useSessions(live) {
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
 * @param {string|null} sessionId @param {object[]} liveCalls
 */
function useCalls(sessionId, liveCalls) {
  const [recorded, setRecorded] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setRecorded(null);
    api.listMcpCalls({ sessionId: sessionId ?? undefined, limit: CALL_LIMIT }, controller.signal).then(
      (next) => {
        setRecorded(next);
        setError(null);
      },
      (err) => {
        if (!controller.signal.aborted) setError(err.message);
      }
    );
    return () => controller.abort();
  }, [sessionId]);

  const calls = useMemo(() => {
    if (!recorded) return null;
    const newest = recorded[0]?.seq ?? -Infinity;
    const fresh = liveCalls.filter(
      (call) => call.seq > newest && (!sessionId || call.sessionId === sessionId)
    );
    return [...fresh, ...recorded].slice(0, CALL_LIMIT);
  }, [recorded, liveCalls, sessionId]);

  return { calls, error };
}

/** @param {{session: object, now: number, filtered: boolean, onFilter: () => void}} props */
function SessionRow({ session, now, filtered, onFilter }) {
  return (
    <div className="group-row">
      <span className="row-icon">
        <Icon name="activity" size={14} />
      </span>
      <div className="row-text">
        <span className="row-title">{clientName(session.client)}</span>
        <span className="row-sub">
          {session.calls} {session.calls === 1 ? 'call' : 'calls'} · connected {ago(session.openedAt, now)}
          {' · '}last seen {ago(session.lastSeenAt, now)}
        </span>
      </div>
      <StatusDot status={session.active ? 'running' : 'stopped'} />
      <span className="audit-session-state">{session.active ? 'active' : 'idle'}</span>
      <IconButton
        icon="logs"
        label={filtered ? 'Show every agent’s calls' : 'Show only this agent’s calls'}
        className={`small ghost${filtered ? ' accent' : ''}`}
        onClick={onFilter}
      />
    </div>
  );
}

/** @param {{call: object, sessions: object[]}} props */
function CallRow({ call, sessions }) {
  const [open, setOpen] = useState(false);
  const client = call.client ?? sessions.find((session) => session.id === call.sessionId)?.client ?? null;
  return (
    <li className="audit-call">
      <button type="button" className="audit-call-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} className="audit-call-chevron" />
        <span className="audit-at">{formatTime(call.at)}</span>
        <span className="audit-call-tool">{call.tool}</span>
        <span className="audit-call-client">{clientName(client)}</span>
        <span className="audit-call-duration">{call.durationMs} ms</span>
        <span className={`audit-call-result ${call.ok ? 'ok' : 'failed'}`}>{call.ok ? 'ok' : 'failed'}</span>
      </button>
      {open && (
        <div className="audit-call-detail">
          {call.error && <p className="notice danger">{call.error}</p>}
          <pre>{JSON.stringify(call.args ?? {}, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

/** @param {{live: {sessions: object[]|null, calls: object[]}}} props */
export default function AgentActivity({ live }) {
  const [sessionFilter, setSessionFilter] = useState(null);
  const { sessions, error: sessionsError } = useSessions(live.sessions);
  const { calls, error: callsError } = useCalls(sessionFilter, live.calls);
  const now = Date.now();
  const known = sessions ?? [];
  const filteredSession = known.find((session) => session.id === sessionFilter);

  return (
    <>
      <SettingsGroup
        title="Connected agents"
        note="Active means seen in the last 5 minutes. Idle sessions close after an hour."
      >
        {sessionsError && <p className="notice danger">{sessionsError}</p>}
        {!sessions && !sessionsError && <p className="empty-inline" role="status">Loading…</p>}
        {sessions?.length === 0 && (
          <p className="empty-inline">No agent is connected. Add the URL above to Claude Code, Cursor or any MCP client.</p>
        )}
        {known.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            now={now}
            filtered={sessionFilter === session.id}
            onFilter={() => setSessionFilter((current) => (current === session.id ? null : session.id))}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={filteredSession ? `Tool calls · ${clientName(filteredSession.client)}` : 'Tool calls'}
        note="Newest first. SQL parameter values are recorded as their types only; agents cannot read or clear this log."
      >
        {sessionFilter && (
          <div className="group-row">
            <span className="row-sub">Showing one agent’s calls.</span>
            <span className="spacer" />
            <button type="button" className="btn small ghost" onClick={() => setSessionFilter(null)}>
              Show all
            </button>
          </div>
        )}
        {callsError && <p className="notice danger">{callsError}</p>}
        {!calls && !callsError && <p className="empty-inline" role="status">Loading…</p>}
        {calls?.length === 0 && <p className="empty-inline">No tool calls recorded yet.</p>}
        {calls?.length > 0 && (
          <ul className="audit-calls">
            {calls.map((call) => (
              <CallRow key={call.seq} call={call} sessions={known} />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </>
  );
}
