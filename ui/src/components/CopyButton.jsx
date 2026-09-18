/**
 * Copies a value the page shows — a path, a command — so it never has to be dragged out of a line
 * that wraps. The glyph turning into a check for a moment is the whole confirmation: a toast would be
 * louder than the act.
 *
 * The clipboard only exists in a secure context, and Paddock bound to a LAN address is not one, so a
 * refusal is expected rather than exceptional and says to select the text instead.
 */
import { useEffect, useState } from 'react';
import IconButton from './IconButton.jsx';

const SETTLE_MS = 1_500;

const ICON = { idle: 'copy', copied: 'check', failed: 'alert' };

const OUTCOME_LABEL = {
  copied: 'Copied',
  failed: 'The browser blocked copying here — select the text instead',
};

/** @param {{text: string, label: string}} props `label` says what is copied: "Copy the log path" */
export default function CopyButton({ text, label }) {
  const [state, setState] = useState('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // Wrapped so a missing `navigator.clipboard` rejects like a refused write instead of throwing.
  const copy = () =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => setState('copied'), () => setState('failed'));

  return (
    <IconButton
      icon={ICON[state]}
      label={OUTCOME_LABEL[state] ?? label}
      className="small ghost copy-button"
      onClick={copy}
    />
  );
}
