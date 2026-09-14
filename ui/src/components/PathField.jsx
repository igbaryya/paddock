/**
 * A path field with a folder browser attached. Browse opens the operating system's own dialog; the
 * in-page browser is only the fallback for a machine that cannot show one (no GUI session, a Linux
 * box without zenity), where it expands underneath the input and stays inside the form.
 *
 * Shared by both configuration forms — a process's repository and a PostgreSQL application's data
 * directory are picked the same way — along with the one path rule the browser can check itself.
 */
import { useState } from 'react';
import Field from './Field.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';
import { pickDirectory } from '../api.js';

/** The manager may be running on a POSIX host or on Windows, so both spellings are absolute. */
export const isAbsolute = (value) => /^([/\\]|[A-Za-z]:[/\\])/.test(value);

/**
 * @param {{label: string, value: string, onChange: (value: string) => void, error?: string|null,
 *          hint?: string, placeholder?: string, start: string}} props `start` is where browsing
 *   opens when the field is still empty
 */
export default function PathField({ label, value, onChange, error, hint, placeholder, start }) {
  const [browsing, setBrowsing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState(null);

  const browse = async () => {
    if (browsing) return setBrowsing(false);
    setPickError(null);
    setPicking(true);
    try {
      const outcome = await pickDirectory(value.trim() || start);
      if (outcome.status === 'picked') onChange(outcome.path);
      if (outcome.status === 'unavailable') setBrowsing(true);
    } catch (err) {
      setPickError(err.message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="path-field">
      <Field
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        hint={hint}
        placeholder={placeholder}
        mono
        action={
          <button
            type="button"
            className="btn small"
            aria-expanded={browsing}
            disabled={picking}
            onClick={browse}
          >
            {picking ? 'Choosing…' : 'Browse…'}
          </button>
        }
      />
      {pickError && (
        <p className="field-error" role="alert">
          {pickError}
        </p>
      )}
      {browsing && (
        <DirectoryPicker
          start={value.trim() || start}
          onPick={(picked) => {
            onChange(picked);
            setBrowsing(false);
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
