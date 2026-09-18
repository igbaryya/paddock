/**
 * A control drawn as its icon alone. The label is both its tooltip and its accessible name, so it
 * has to say what the button does to what — a row of unlabelled "Stop"s is useless to a screen
 * reader, and to anyone hovering over one of five identical squares.
 */
import Icon from './Icon.jsx';

/**
 * @param {{icon: string, label: string, className?: string}} props plus any <button> attribute;
 *   `className` carries the usual .btn modifiers (small, ghost, primary, danger)
 */
export default function IconButton({ icon, label, className = '', ...button }) {
  return (
    <button
      type="button"
      className={`btn icon-button ${className}`}
      title={label}
      aria-label={label}
      {...button}
    >
      <Icon name={icon} />
    </button>
  );
}
