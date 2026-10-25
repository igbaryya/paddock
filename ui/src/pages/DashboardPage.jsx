/**
 * The landing page: everything Paddock watches, on one screen — the applications and what has gone
 * wrong with them, the machine they run on, its network, and the agents driving them over MCP. Each
 * section is a summary that links to the page where it is acted on; nothing is operated from here.
 *
 * This is the screen someone leaves open, so it answers "is anything broken" from across the desk:
 * the worst status sorts first, and a figure is coloured only when it is news.
 */
import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { CallRow } from '../components/AgentActivity.jsx';
import Icon from '../components/Icon.jsx';
import { AddressFact } from '../components/NetworkPanel.jsx';
import NotLoaded from '../components/NotLoaded.jsx';
import NotificationRow from '../components/NotificationRow.jsx';
import Stat from '../components/Stat.jsx';
import StatusDot from '../components/StatusDot.jsx';
import {
  LevelBar, Sparkline, cpuDetail, diskDetail, memoryDetail, toneOf,
} from '../components/SystemMeters.jsx';
import Toolbar from '../components/Toolbar.jsx';
import WebLink from '../components/WebLink.jsx';
import { clientName, describeMcpListener, describePrivateIp, describePublicIp } from '../format.js';
import { Link, paths } from '../router.jsx';
import { useCalls, useSessions } from '../useAgentActivity.js';

/** Worst first, so what needs a look is at the top of the list. */
const SEVERITY = ['failed', 'partial', 'stopping', 'starting', 'running', 'stopped'];
const ATTENTION = new Set(['failed', 'partial']);

const RECENT_PROBLEMS = 6;
const RECENT_CALLS = 5;

const WAITING = 'Waiting for the first reading…';

const bySeverity = (a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status);

const sumOf = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

/**
 * A panel with its title, and a link to the page that has the whole of it.
 * @param {{icon: string, title: string, link?: {to: string, label: string}, children: React.ReactNode}} props
 */
function Section({ icon, title, link, children }) {
  return (
    <section className="panel dashboard-section" aria-label={title}>
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name={icon} />
          {title}
        </h2>
        <span className="spacer" />
        {link && (
          <Link to={link.to} className="btn small ghost">
            {link.label}
            <Icon name="chevron" size={12} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * One number per thing that can go wrong. `—` until its source has answered, so a count that is
 * not known yet never reads as zero.
 * @param {{applications: object[], ports: object, sessions: object[]|null}} props
 */
function HealthStrip({ applications, ports, sessions }) {
  const running = applications.filter((a) => a.status === 'running').length;
  const attention = applications.filter((a) => ATTENTION.has(a.status)).length;
  const services = sumOf(applications, (a) => a.processCounts.running);
  const enabled = sumOf(applications, (a) => a.processCounts.enabled);
  const listening = ports.ports;
  const exposed = (listening ?? []).filter((p) => p.exposed).length;
  const agents = (sessions ?? []).filter((s) => s.active).length;

  return (
    <div className="stat-row">
      <Stat icon="grid" value={`${running}/${applications.length}`} label="apps running" tone="ok" />
      <Stat icon="activity" value={`${services}/${enabled}`} label="services running" tone="ok" />
      <Stat icon="alert" value={attention} label="need attention" tone={attention ? 'warn' : undefined} />
      <Stat icon="ports" value={listening ? listening.length : '—'} label="ports listening" />
      <Stat
        icon="globe"
        value={listening ? exposed : '—'}
        label="ports exposed"
        tone={exposed ? 'warn' : undefined}
      />
      <Stat icon="braces" value={sessions ? agents : '—'} label="agents active" />
    </div>
  );
}

/** @param {{application: object}} props */
function ApplicationRow({ application }) {
  const { running, enabled } = application.processCounts;
  const site = application.processes.find((process) => process.web);
  return (
    <li className="dashboard-app">
      <Link to={paths.application(application.id)} className="apps-name">
        {application.name}
      </Link>
      <StatusDot status={application.status} showLabel />
      <span className="meta">
        {running}/{enabled} running
      </span>
      <span className="dashboard-app-web">{site && <WebLink web={site.web} name={site.name} />}</span>
    </li>
  );
}

/** @param {{applications: object[], onCreate: () => void}} props */
function ApplicationsSection({ applications, onCreate }) {
  return (
    <Section icon="grid" title="Applications" link={{ to: paths.overview(), label: 'All applications' }}>
      {applications.length === 0 ? (
        <div className="empty-inline">
          <p>No applications yet.</p>
          <button type="button" className="btn small primary" onClick={onCreate}>
            Create the first one
          </button>
        </div>
      ) : (
        <ul className="dashboard-list">
          {[...applications].sort(bySeverity).map((application) => (
            <ApplicationRow key={application.id} application={application} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * The bell's notifications, less the update: what crashed or failed to start while this window was
 * open, and whatever was already down when it opened.
 * @param {{items: object[]}} props
 */
function ProblemsSection({ items }) {
  const problems = items.filter((item) => item.kind === 'process').slice(0, RECENT_PROBLEMS);
  return (
    <Section icon="alert" title="Recent problems">
      {problems.length === 0 ? (
        <p className="empty-inline">Nothing has crashed or failed to start since this window opened.</p>
      ) : (
        <ul className="notifications-list">
          {problems.map((item) => (
            <NotificationRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * The sidebar's meter, given room: the figure large, the trace tall, and the detail written out
 * instead of hidden in a tooltip.
 * @param {{label: string, percent: number|null, detail: string, children: React.ReactNode}} props
 */
function Gauge({ label, percent, detail, children }) {
  const known = Number.isFinite(percent);
  return (
    <div className={`dashboard-gauge meter-${toneOf(percent)}`}>
      <div className="dashboard-gauge-head">
        <span className="dashboard-gauge-label">{label}</span>
        <span className="dashboard-gauge-value">{known ? `${Math.round(percent)}%` : '—'}</span>
      </div>
      <div className="dashboard-gauge-graph">{children}</div>
      <p className="dashboard-gauge-detail">{detail}</p>
    </div>
  );
}

/** @param {{system: {latest: object|null, history: object[]}}} props */
function MachineSection({ system }) {
  const { latest, history } = system;
  const trace = (pick) => history.map((sample) => pick(sample) ?? null);
  const detail = (describe, part) => (latest ? describe(part) : WAITING);
  return (
    <Section icon="cpu" title="Machine">
      <Gauge label="CPU" percent={latest?.cpu?.percent ?? null} detail={detail(cpuDetail, latest?.cpu)}>
        <Sparkline values={trace((sample) => sample.cpu?.percent)} />
      </Gauge>
      <Gauge label="Memory" percent={latest?.memory?.percent ?? null} detail={detail(memoryDetail, latest?.memory)}>
        <Sparkline values={trace((sample) => sample.memory?.percent)} />
      </Gauge>
      <Gauge label="Disk" percent={latest?.disk?.percent ?? null} detail={detail(diskDetail, latest?.disk)}>
        <LevelBar percent={latest?.disk?.percent ?? null} />
      </Gauge>
    </Section>
  );
}

/** The hostname as a fact, with how many interfaces are up beside it. */
function describeHostname(network) {
  if (!network) return { address: null, value: '—', note: WAITING };
  const count = network.interfaces.length;
  const note = `${count} ${count === 1 ? 'interface' : 'interfaces'} up`;
  return { address: network.hostname, value: network.hostname, note };
}

/** @param {{network: object|null}} props */
function NetworkSection({ network }) {
  return (
    <Section icon="network" title="Network" link={{ to: paths.ports(), label: 'Interfaces' }}>
      <dl className="group-facts">
        <AddressFact label="Private IP" described={describePrivateIp(network)} />
        <AddressFact label="Public IP" described={describePublicIp(network)} />
        <AddressFact label="Hostname" described={describeHostname(network)} />
      </dl>
    </Section>
  );
}

/**
 * The listener's state, read once: nothing on the stream announces it, and it changes only from
 * the MCP settings tab.
 */
function useMcpListener() {
  const [mcp, setMcp] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api.getMcp(controller.signal).then(setMcp, () => {});
    return () => controller.abort();
  }, []);
  return mcp;
}

/** Enabled but not listening is the one state where an agent silently cannot connect. */
const failedToStart = (mcp) => Boolean(mcp?.lastError && !mcp.running);

const listenerText = (mcp) => {
  if (!mcp) return 'Loading…';
  if (failedToStart(mcp)) return `Could not start: ${mcp.lastError.message}`;
  return describeMcpListener(mcp);
};

/** @param {{mcp: object|null}} props */
function ListenerRow({ mcp }) {
  const running = Boolean(mcp?.configured && mcp.running);
  return (
    <div className="group-row">
      <span className="row-icon">
        <Icon name="braces" size={14} />
      </span>
      <div className="row-text">
        <span className="row-title">MCP server</span>
        <span className={`row-sub${failedToStart(mcp) ? ' danger' : ''}`}>{listenerText(mcp)}</span>
      </div>
      <StatusDot status={running ? 'running' : 'stopped'} showLabel />
    </div>
  );
}

/** @param {{sessions: object[]|null}} props */
function AgentList({ sessions }) {
  if (!sessions) return <p className="empty-inline" role="status">Loading…</p>;
  if (sessions.length === 0) return <p className="empty-inline">No agent is connected.</p>;
  return (
    <ul className="dashboard-agents">
      {sessions.map((session) => (
        <li key={session.id} className="dashboard-agent">
          <StatusDot status={session.active ? 'running' : 'stopped'} />
          <span className="dashboard-agent-name">{clientName(session.client)}</span>
          <span className="meta">
            {session.calls} {session.calls === 1 ? 'call' : 'calls'} · {session.active ? 'active' : 'idle'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** @param {{sessions: object[]|null, liveCalls: object[]}} props */
function AgentsSection({ sessions, liveCalls }) {
  const mcp = useMcpListener();
  const { calls } = useCalls({ limit: RECENT_CALLS }, liveCalls);
  return (
    <Section icon="braces" title="Agents" link={{ to: paths.mcp(), label: 'Full audit' }}>
      <div className="dashboard-rows">
        <ListenerRow mcp={mcp} />
        <AgentList sessions={sessions} />
      </div>
      <p className="group-subhead">Recent tool calls</p>
      {!calls && <p className="empty-inline" role="status">Loading…</p>}
      {calls?.length === 0 && <p className="empty-inline">No tool calls recorded yet.</p>}
      {calls?.length > 0 && (
        <ul className="audit-calls">
          {calls.map((call) => (
            <CallRow key={call.seq} call={call} sessions={sessions ?? []} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * @param {{applications: object[], loaded: boolean, unreachable: boolean, ports: object,
 *          system: {latest: object|null, history: object[]}, network: object|null,
 *          agents: {sessions: object[]|null, calls: object[]}, problems: object[],
 *          onRetry: () => void, onCreate: () => void}} props `agents` is the stream's MCP activity,
 *   `problems` the bell's list
 */
export default function DashboardPage({
  applications,
  loaded,
  unreachable,
  ports,
  system,
  network,
  agents,
  problems,
  onRetry,
  onCreate,
}) {
  // Fetched here rather than in each section: the strip counts the active ones too.
  const { sessions } = useSessions(agents.sessions);

  return (
    <>
      <Toolbar title="Dashboard" subtitle="Everything Paddock is watching, on one screen." />

      {!loaded ? (
        <NotLoaded unreachable={unreachable} onRetry={onRetry} />
      ) : (
        <>
          <HealthStrip applications={applications} ports={ports} sessions={sessions} />

          <div className="dashboard-grid">
            <ApplicationsSection applications={applications} onCreate={onCreate} />
            <ProblemsSection items={problems} />
          </div>

          <div className="dashboard-grid">
            <AgentsSection sessions={sessions} liveCalls={agents.calls} />
            <div className="dashboard-stack">
              <MachineSection system={system} />
              <NetworkSection network={network} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
