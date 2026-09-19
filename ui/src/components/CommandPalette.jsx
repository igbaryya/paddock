/**
 * Global search: pages, applications, processes, and safe actions in one place.
 *
 * Opens with ⌘/Ctrl+K. Arrow keys move, Enter runs, Escape closes without touching whatever is
 * underneath.
 */
import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { filterCommands } from '../commands.js';

const MOD_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  ? '⌘'
  : 'Ctrl';

/**
 * @param {{open: boolean, commands: object[], onClose: () => void}} props
 */
export default function CommandPalette({ open, commands, onClose }) {
  const titleId = useId();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const filtered = filterCommands(commands, query);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    const row = listRef.current?.querySelector('[data-active="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, filtered.length]);

  if (!open) return null;

  const clampedActive = filtered.length ? Math.min(active, filtered.length - 1) : 0;

  const run = (command) => {
    command.run();
    onClose();
  };

  const onInputKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filtered.length) return;
      setActive((index) => (index + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filtered.length) return;
      setActive((index) => (index - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = filtered[clampedActive];
      if (command) run(command);
    }
  };

  return (
    <div
      className="backdrop command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>

        <div className="command-palette-head">
          <div className="search-wrap command-palette-search">
            <Icon name="search" size={15} className="search-icon" />
            <input
              ref={inputRef}
              type="search"
              className="search command-palette-input"
              placeholder="Search pages, actions…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="off"
              spellCheck={false}
              aria-controls="command-palette-list"
              aria-activedescendant={
                filtered[clampedActive] ? `command-${filtered[clampedActive].id}` : undefined
              }
            />
            <kbd className="command-kbd command-kbd-esc">esc</kbd>
          </div>
        </div>

        <ul
          id="command-palette-list"
          className="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
        >
          {filtered.length === 0 ? (
            <li className="command-palette-empty">No matches.</li>
          ) : (
            filtered.map((command, index) => {
              const selected = index === clampedActive;
              return (
                <li key={command.id} role="none">
                  <button
                    type="button"
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    data-active={selected ? 'true' : undefined}
                    className={`command-row${selected ? ' active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(command)}
                  >
                    <span className="command-row-icon">
                      <Icon name={command.icon} size={16} />
                    </span>
                    <span className="command-row-body">
                      <span className="command-row-title">{command.title}</span>
                      <span className="command-row-subtitle">{command.subtitle}</span>
                    </span>
                    {selected && <Icon name="chevron" size={14} className="command-row-chevron" />}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <footer className="command-palette-foot">
          <span className="command-foot-hint">
            <kbd className="command-kbd">↑</kbd>
            <kbd className="command-kbd">↓</kbd>
            to navigate
          </span>
          <span className="command-foot-hint">
            <kbd className="command-kbd">↵</kbd>
            to select
          </span>
          <span className="command-foot-hint command-foot-toggle">
            <kbd className="command-kbd">{MOD_LABEL} K</kbd>
            to toggle
          </span>
        </footer>
      </div>
    </div>
  );
}
