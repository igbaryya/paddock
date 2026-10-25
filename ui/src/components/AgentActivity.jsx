/**
 * Which agents are connected over MCP, and every tool call they made — the audit the owner reads to
 * answer "what did the agent just do to my stack".
 *
 * The page fetches what is already recorded, then the live stream adds to it: sessions are replaced
 * whenever one connects, identifies itself or leaves, and each call arrives as it is made. A call
 * opens to its arguments and its error, so "it restarted the backend" can be checked against what it
 * was actually asked to do. Nothing here can change or clear the audit.
 */
import { useState } from 'react';
import { ago, clientName, formatTime } from '../format.js';
import { useCalls, useSessions } from '../useAgentActivity.js';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import SettingsGroup from './SettingsGroup.jsx';
import StatusDot from './StatusDot.jsx';

const CALL_LIMIT = 200;

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

/**
 * Exported for the dashboard's recent calls, which open to the same detail.
 * @param {{call: object, sessions: object[]}} props
 */
export function CallRow({ call, sessions }) {
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
  const { calls, error: callsError } = useCalls({ sessionId: sessionFilter, limit: CALL_LIMIT }, live.calls);
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
          <p className="empty-inline">No agent is connected. Add Paddock to Cursor or Claude Code above, or give its URL to any MCP client.</p>
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
