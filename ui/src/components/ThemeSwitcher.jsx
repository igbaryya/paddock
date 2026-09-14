/**
 * The theme choice: System, Light or Dark, as one segmented control.
 *
 * Radio semantics rather than three buttons, because it is exactly one of three — so it is a single
 * tab stop, the arrow keys move the choice, and a screen reader announces "Light, 2 of 3". The same
 * control appears in the sidebar and on the Settings page; both read one store, so they cannot
 * disagree.
 */
import { useRef } from 'react';
import Icon from './Icon.jsx';
import { THEMES, setThemePreference, useTheme } from '../useTheme.js';

const OPTIONS = {
  system: { icon: 'monitor', label: 'System' },
  light: { icon: 'sun', label: 'Light' },
  dark: { icon: 'moon', label: 'Dark' },
};

const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export default function ThemeSwitcher() {
  const { preference, resolved } = useTheme();
  const groupRef = useRef(null);

  /** Arrow keys select as they move, the way a native radio group behaves. */
  const onKeyDown = (event) => {
    const step = STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const next = THEMES[(THEMES.indexOf(preference) + step + THEMES.length) % THEMES.length];
    setThemePreference(next);
    groupRef.current?.querySelector(`[data-option="${next}"]`)?.focus();
  };

  return (
    <div
      ref={groupRef}
      className="segmented theme-switcher"
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
    >
      {THEMES.map((theme) => {
        const { icon, label } = OPTIONS[theme];
        const checked = preference === theme;
        return (
          <button
            key={theme}
            type="button"
            role="radio"
            data-option={theme}
            aria-checked={checked}
            // Roving tab stop: only the chosen option is reachable with Tab.
            tabIndex={checked ? 0 : -1}
            className={`segment${checked ? ' selected' : ''}`}
            // "System" alone does not say what you are actually looking at.
            title={theme === 'system' ? `Follow the system (currently ${resolved})` : label}
            onClick={() => setThemePreference(theme)}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
