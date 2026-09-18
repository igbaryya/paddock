/**
 * One number on a page's summary strip, beside what it counts. `tone` colours it only when the
 * number is news in itself: running is good news, needing attention is not, and a count of ports is
 * neither.
 */
import Icon from './Icon.jsx';

/**
 * @param {{icon: string, value: React.ReactNode, label: string, tone?: 'ok'|'warn'}} props
 */
export default function Stat({ icon, value, label, tone }) {
  return (
    <div className={tone ? `stat stat-${tone}` : 'stat'}>
      <span className="stat-icon">
        <Icon name={icon} size={15} />
      </span>
      <span className="stat-text">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
      </span>
    </div>
  );
}
