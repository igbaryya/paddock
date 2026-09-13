/**
 * A labelled text control with its hint and validation message, wired together by one generated id
 * so the error is announced with the field it belongs to. The shared `nameError` rule lives here
 * too: it is the one check both configuration forms apply.
 */
import { useId } from 'react';

const MAX_NAME = 80;

/**
 * Mirrors the manager's own name rule so a typo does not need a round trip. The manager still
 * decides — uniqueness, for one, can only be checked there.
 * @param {string} value
 */
export const nameError = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return 'Name is required';
  if (trimmed.length > MAX_NAME) return `Name must be ${MAX_NAME} characters or fewer`;
  return null;
};

/**
 * @param {{label: string, value: string, onChange: (value: string) => void, error?: string|null,
 *          hint?: string, rows?: number, placeholder?: string, spellCheck?: boolean,
 *          mono?: boolean, action?: React.ReactNode}} props `action` sits to the right of the
 *   control, for a field that has something to offer beyond typing into it
 */
export default function Field({
  label,
  value,
  onChange,
  error,
  hint,
  rows,
  placeholder,
  spellCheck,
  mono,
  action,
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const shared = {
    id,
    value,
    placeholder,
    className: mono ? 'mono' : undefined,
    spellCheck: spellCheck ?? false,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
    onChange: (event) => onChange(event.target.value),
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {/* Always wrapped, action or not: one layout for every field beats a branch that produces two. */}
      <div className="field-control">
        {rows ? <textarea {...shared} rows={rows} /> : <input type="text" {...shared} />}
        {action}
      </div>
      {hint && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
