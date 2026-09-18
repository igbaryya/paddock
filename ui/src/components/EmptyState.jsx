/**
 * The screen for "there is nothing here", said in the same shape wherever it is said: what is
 * missing, why, and the one thing to do about it.
 */
import Icon from './Icon.jsx';

/**
 * @param {{icon: string, title: string, children: React.ReactNode, action?: React.ReactNode}} props
 */
export default function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
