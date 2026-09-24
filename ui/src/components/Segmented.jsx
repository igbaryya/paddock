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

/** Arrow keys and Home/End for a tablist: the step from the chosen tab, wrapping at the ends. */
const TAB_KEYS = {
  ArrowRight: (index) => index + 1,
  ArrowLeft: (index) => index - 1,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/**
 * @param {{options: {id: string, label: import('react').ReactNode}[], value: string,
 *          onChange: (id: string) => void, label: string, role?: 'group'|'tablist',
 *          panelId?: string, className?: string}} props
 *   `panelId` is the tabpanel the tabs switch, for `aria-controls`.
 */
export default function Segmented({
  options,
  value,
  onChange,
  label,
  role = 'group',
  panelId,
  className = '',
}) {
  const tabs = role === 'tablist';

  // A tablist is one Tab stop, and the arrows move the choice along it — the pattern screen readers
  // announce a tablist as having.
  const onKeyDown = (event) => {
    const step = TAB_KEYS[event.key];
    if (!tabs || !step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.id === value);
    const next = (step(index, options.length) + options.length) % options.length;
    onChange(options[next].id);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      className={`segmented ${className}`.trim()}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? chosen : undefined}
            aria-controls={tabs ? panelId : undefined}
            tabIndex={tabs && !chosen ? -1 : undefined}
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
