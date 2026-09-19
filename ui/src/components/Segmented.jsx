/**
 * Several options with one of them chosen, drawn as a track with the chosen option standing proud of
 * it — the log viewer's source and stream pickers, and the drawer's tabs.
 *
 * `role` is what separates the two meanings of the same object on screen: a `group` of pressed
 * buttons filters what is already there, while a `tablist` switches which panel is shown. They look
 * identical and are announced differently, which is the whole reason this takes the role rather than
 * guessing it.
 *
 * The theme switcher deliberately does not use this: it is one of three mutually exclusive settings,
 * so it carries radio semantics and a roving tab stop, and only shares the styling.
 */

/**
 * @param {{options: {id: string, label: import('react').ReactNode}[], value: string,
 *          onChange: (id: string) => void, label: string, role?: 'group'|'tablist',
 *          className?: string}} props
 */
export default function Segmented({
  options,
  value,
  onChange,
  label,
  role = 'group',
  className = '',
}) {
  const tabs = role === 'tablist';
  return (
    <div className={`segmented ${className}`.trim()} role={role} aria-label={label}>
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? chosen : undefined}
            aria-pressed={tabs ? undefined : chosen}
            className={`segment${chosen ? ' selected' : ''}`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
