/**
 * A titled group of rows, with the small print underneath it where the OS puts a group's footnote.
 * Shared by every settings-shaped page, so a screen reader announces each group by its title on all
 * of them rather than on some.
 */
import { useId } from 'react';

/** @param {{title: string, note?: React.ReactNode, children: React.ReactNode}} props */
export default function SettingsGroup({ title, note, children }) {
  const titleId = useId();
  return (
    <section className="settings-section" aria-labelledby={titleId}>
      <h2 className="group-title" id={titleId}>{title}</h2>
      <div className="group">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  );
}
