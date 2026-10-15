/**
 * The Shortcuts tab: every rebindable action, grouped, with its keys on the right.
 *
 * Clicking the keys starts listening; the next combination pressed becomes the shortcut, Escape or
 * leaving the field keeps the old one. A combination another action already has is not silently
 * stolen — the row asks first, because the other action would otherwise just stop answering.
 */
import { useEffect, useState } from 'react';
import IconButton from './IconButton.jsx';
import SettingsGroup from './SettingsGroup.jsx';
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  actionById,
  actionFor,
  comboFromEvent,
  formatCombo,
  rejectCombo,
} from '../shortcuts.js';
import {
  IS_MAC,
  resetAllShortcuts,
  resetShortcut,
  setRecording,
  setShortcut,
  useShortcuts,
} from '../useShortcuts.js';

const GROUP_NOTES = {
  'Open application': 'These act on the application whose page is open, and do nothing elsewhere.',
};

/** The browser keeps a few combinations for itself; the desktop app hands every one to the page. */
const IN_BROWSER = typeof window !== 'undefined' && !window.paddockDesktop;

const show = (combo) => formatCombo(combo, IS_MAC);

/**
 * @param {{action: object, combo: string|null, editing: object|null,
 *          onEdit: (next: object|null) => void, bindings: Record<string, string|null>}} props
 *   `editing` is this row's state while it is being changed: listening for keys, or holding a
 *   combination that another action has until the user says whether to move it.
 */
function ShortcutRow({ action, combo, editing, onEdit, bindings }) {
  const listening = editing?.phase === 'listening';
  const conflict = editing?.phase === 'conflict' ? editing : null;
  const fallback = DEFAULT_BINDINGS[action.id];
  const changed = combo !== fallback;

  const onKeyDown = (event) => {
    if (!listening) return;
    if (event.key === 'Tab') return; // leaves the field, which cancels on blur
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      onEdit(null);
      return;
    }
    const next = comboFromEvent(event);
    if (!next) return; // a modifier on its own: still pressing
    if (next === combo) {
      onEdit(null);
      return;
    }
    const reason = rejectCombo(next, IS_MAC);
    if (reason) {
      onEdit({ phase: 'listening', error: reason });
      return;
    }
    const other = actionFor(bindings, next, action.id);
    if (other) {
      onEdit({ phase: 'conflict', combo: next, other });
      return;
    }
    setShortcut(action.id, next);
    onEdit(null);
  };

  let sub = null;
  if (listening) sub = editing.error ?? 'Press the new keys, or Esc to keep the current ones.';
  else if (conflict) sub = `${show(conflict.combo)} is on “${actionById(conflict.other).label}”. Move it here?`;
  else if (changed) sub = `Default: ${fallback ? show(fallback) : 'none'}`;

  return (
    <div
      className="group-row"
      onKeyDown={(event) => {
        if (conflict && event.key === 'Escape') onEdit(null);
      }}
    >
      <div className="row-text">
        <span className="row-title">{action.label}</span>
        {sub && (
          <span className={`row-sub${listening && editing.error ? ' danger' : ''}`} role="status">
            {sub}
          </span>
        )}
      </div>

      {conflict ? (
        <>
          <button type="button" className="btn small ghost" onClick={() => onEdit(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn small primary"
            autoFocus
            onClick={() => {
              setShortcut(action.id, conflict.combo);
              onEdit(null);
            }}
          >
            Move it
          </button>
        </>
      ) : (
        <>
          {changed && !listening && (
            <button type="button" className="btn small ghost" onClick={() => resetShortcut(action.id)}>
              Reset
            </button>
          )}
          {combo && !listening && (
            <IconButton
              icon="close"
              label={`Remove the shortcut for ${action.label}`}
              className="small ghost"
              onClick={() => setShortcut(action.id, null)}
            />
          )}
          <button
            type="button"
            className={`btn small shortcut-keys${listening ? ' listening' : ''}`}
            aria-label={
              listening
                ? `Press new keys for ${action.label}`
                : `${action.label}: ${combo ? show(combo) : 'no shortcut'}. Change`
            }
            onClick={(event) => {
              // Safari does not focus a clicked button, and the keys are read from this one.
              event.currentTarget.focus();
              onEdit(listening ? null : { phase: 'listening' });
            }}
            onKeyDown={onKeyDown}
            onBlur={() => listening && onEdit(null)}
          >
            {listening ? 'Press keys…' : combo ? <kbd className="command-kbd">{show(combo)}</kbd> : 'Not set'}
          </button>
        </>
      )}
    </div>
  );
}

export default function ShortcutsSettings() {
  const { bindings } = useShortcuts();
  const [editing, setEditing] = useState(null);
  const groups = [...new Set(SHORTCUT_ACTIONS.map((action) => action.group))];
  const anyChanged = SHORTCUT_ACTIONS.some(({ id }) => bindings[id] !== DEFAULT_BINDINGS[id]);

  useEffect(() => {
    setRecording(Boolean(editing));
  }, [editing]);
  useEffect(() => () => setRecording(false), []);

  return (
    <>
      {groups.map((group) => (
        <SettingsGroup
          key={group}
          title={group}
          note={
            group === 'General' && IN_BROWSER
              ? `In a browser tab the browser keeps some combinations for itself — ${show('Mod+N')} opens a new window there. In the Paddock app, every one works.`
              : GROUP_NOTES[group]
          }
        >
          {SHORTCUT_ACTIONS.filter((action) => action.group === group).map((action) => (
            <ShortcutRow
              key={action.id}
              action={action}
              combo={bindings[action.id]}
              bindings={bindings}
              editing={editing?.id === action.id ? editing : null}
              onEdit={(next) => setEditing(next && { ...next, id: action.id })}
            />
          ))}
          {group === 'Go to' && (
            <div className="group-row">
              <div className="row-text">
                <span className="row-title">Application 1–9</span>
                <span className="row-sub">In the order the sidebar lists them. Not changeable.</span>
              </div>
              <kbd className="command-kbd">{show('Mod+1')}–{show('Mod+9')}</kbd>
            </div>
          )}
        </SettingsGroup>
      ))}

      <SettingsGroup title="Defaults" note="Shortcuts are saved in this browser only.">
        <div className="group-row">
          <div className="row-text">
            <span className="row-title">Restore every shortcut</span>
            <span className="row-sub">
              {anyChanged ? 'Puts each one back on the keys it came with.' : 'Every shortcut is on its default keys.'}
            </span>
          </div>
          <button
            type="button"
            className="btn small"
            disabled={!anyChanged}
            onClick={() => {
              setEditing(null);
              resetAllShortcuts();
            }}
          >
            Restore defaults
          </button>
        </div>
      </SettingsGroup>
    </>
  );
}
