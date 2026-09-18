/**
 * The toggle, as a checkbox with the switch role: native keyboard and form behaviour, and a screen
 * reader announces on/off rather than checked/unchecked. The track is drawn on a sibling span rather
 * than on the input's own ::before, which Firefox does not render.
 *
 * `children`, when given, is visible text inside the same label, so clicking the words flips it too.
 * @param {{checked: boolean, disabled?: boolean, label: string, onChange: (next: boolean) => void,
 *          children?: React.ReactNode}} props
 */
export default function Switch({ checked, disabled = false, label, onChange, children }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      {children && <span className="switch-text">{children}</span>}
    </label>
  );
}
