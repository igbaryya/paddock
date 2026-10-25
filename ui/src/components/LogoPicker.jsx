/**
 * Replace Paddock's mark with your own image, or go back to it — one row, the same in Settings and in
 * the setup wizard. The file is read in this browser and sent as a data URL. The manager reads what
 * it actually is and has the last word on its size, so the check here only saves a round trip for an
 * image that was never going to fit.
 */
import { useRef, useState } from 'react';
import { formatBytes } from '../format.js';
import { resetLogo, setLogo, useBranding } from '../useBranding.js';
import Icon, { Logo } from './Icon.jsx';

/** The manager's limit (branding.js), restated. */
const MAX_BYTES = 262_144;

/** What the manager can tell apart from its bytes; anything else it refuses. */
const ACCEPT = 'image/png,image/svg+xml,image/jpeg,image/webp,image/gif,image/x-icon';

/** @param {File} file @returns {Promise<string>} */
const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.readAsDataURL(file);
  });

const describe = (logo) =>
  logo
    ? `Your image · ${formatBytes(logo.bytes)}`
    : `Paddock's own mark. PNG, SVG, JPEG, WebP, GIF or ICO, up to ${formatBytes(MAX_BYTES)}.`;

export default function LogoPicker() {
  const { logo } = useBranding();
  const inputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (operation) => {
    setSaving(true);
    setError(null);
    try {
      await operation();
    } catch (err) {
      setError(err.message); // the manager's own words: it says what the image actually is
    } finally {
      setSaving(false);
    }
  };

  const choose = (event) => {
    const [file] = event.target.files;
    // Cleared, so picking the same file again after a reset is still a change.
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is ${formatBytes(file.size)}; the logo must be ${formatBytes(MAX_BYTES)} or smaller.`);
      return;
    }
    save(async () => setLogo(await readAsDataUrl(file)));
  };

  return (
    <>
      <div className="group-row">
        <span className="logo-preview"><Logo size={32} /></span>
        <div className="row-text">
          <span className="row-title">Logo</span>
          <span className="row-sub" role="status">{saving ? 'Saving…' : describe(logo)}</span>
        </div>
        {logo && (
          <button type="button" className="btn small ghost" disabled={saving} onClick={() => save(resetLogo)}>
            Use Paddock's
          </button>
        )}
        <button type="button" className="btn small" disabled={saving} onClick={() => inputRef.current.click()}>
          Choose image…
        </button>
        <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={choose} />
      </div>
      {error && (
        <div className="group-row row-warn">
          <Icon name="alert" />
          <span className="row-text row-sub">{error}</span>
        </div>
      )}
    </>
  );
}
