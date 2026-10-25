/**
 * The machine's load at the foot of the sidebar: CPU, memory and disk, on every page. A build that
 * has slowed to a crawl is as often the machine as the code, and this is how to tell at a glance.
 *
 * CPU and memory move second to second, so each gets a trace of the last couple of minutes; disk
 * barely moves in that time, and a level bar says more about it than a flat line would. The exact
 * figures are in each row's tooltip.
 *
 * The trace, the bar, the tone and the wording are exported for the dashboard, which shows the same
 * readings larger and must not describe them differently.
 */
import Icon from './Icon.jsx';
import { formatBytes } from '../format.js';
import { MAX_SYSTEM_SAMPLES } from '../useLiveState.js';

/** Memory on a healthy Mac sits around 70–80%, so only past that is it news. */
const WARN_AT = 85;
const DANGER_AT = 95;

export const toneOf = (percent) => {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= DANGER_AT) return 'danger';
  if (percent >= WARN_AT) return 'warn';
  return 'ok';
};

const VIEW_HEIGHT = 16;

/**
 * Drawn from the right edge, one slot per reading, so the trace scrolls left as readings arrive
 * instead of stretching to fit however many there are so far.
 * @param {{values: (number|null)[]}} props percentages, oldest first
 */
export function Sparkline({ values }) {
  const step = 100 / (MAX_SYSTEM_SAMPLES - 1);
  const points = values
    .map((value, i) => [100 - (values.length - 1 - i) * step, value])
    .filter(([, value]) => Number.isFinite(value))
    .map(([x, value]) => [x, VIEW_HEIGHT - (Math.min(100, Math.max(0, value)) / 100) * VIEW_HEIGHT]);
  if (!points.length) return <svg className="sparkline" aria-hidden="true" />;
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 100 ${VIEW_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline className="sparkline-line" points={line} />
    </svg>
  );
}

/** @param {{percent: number|null}} props */
export function LevelBar({ percent }) {
  const width = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <span className="level-bar" aria-hidden="true">
      <span className="level-bar-fill" style={{ width: `${width}%` }} />
    </span>
  );
}

/**
 * @param {{icon: string, label: string, percent: number|null, detail: string,
 *          children: React.ReactNode}} props
 */
function Meter({ icon, label, percent, detail, children }) {
  const known = Number.isFinite(percent);
  return (
    <div
      className={`meter meter-${toneOf(percent)}`}
      role={known ? 'meter' : undefined}
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? percent : undefined}
      aria-valuetext={known ? detail : undefined}
      title={detail}
    >
      <Icon name={icon} />
      <span className="meter-label">{label}</span>
      <span className="meter-graph">{children}</span>
      <span className="meter-value">{known ? `${Math.round(percent)}%` : '—'}</span>
    </div>
  );
}

export function cpuDetail(cpu) {
  if (!Number.isFinite(cpu?.percent)) return 'CPU: measuring…';
  const load = cpu.loadAverage ? ` · load ${cpu.loadAverage.join(' ')}` : '';
  return `CPU ${cpu.percent}% across ${cpu.cores} cores${load}`;
}

export function memoryDetail(memory) {
  if (!memory) return 'Memory: could not be read';
  return `Memory ${formatBytes(memory.used)} of ${formatBytes(memory.total)} in use`;
}

export function diskDetail(disk) {
  if (!disk) return 'Disk: could not be read';
  return `Disk ${formatBytes(disk.free)} free of ${formatBytes(disk.total)} (${disk.path})`;
}

/**
 * @param {{system: {latest: object|null, history: object[]}, stale: boolean}} props `stale` while
 *   the stream is down, so the last readings are not mistaken for current ones
 */
export default function SystemMeters({ system, stale }) {
  const { latest, history } = system;
  if (latest?.intervalMs === 0) return null;
  const detail = (describe, part) => (latest ? describe(part) : 'Waiting for the first reading…');
  return (
    <div className={`system-meters${stale ? ' stale' : ''}`} role="group" aria-label="System load">
      <p className="sidebar-label">System</p>
      <Meter icon="cpu" label="CPU" percent={latest?.cpu?.percent ?? null} detail={detail(cpuDetail, latest?.cpu)}>
        <Sparkline values={history.map((sample) => sample.cpu?.percent ?? null)} />
      </Meter>
      <Meter
        icon="memory"
        label="Memory"
        percent={latest?.memory?.percent ?? null}
        detail={detail(memoryDetail, latest?.memory)}
      >
        <Sparkline values={history.map((sample) => sample.memory?.percent ?? null)} />
      </Meter>
      <Meter
        icon="disk"
        label="Disk"
        percent={latest?.disk?.percent ?? null}
        detail={detail(diskDetail, latest?.disk)}
      >
        <LevelBar percent={latest?.disk?.percent ?? null} />
      </Meter>
    </div>
  );
}
