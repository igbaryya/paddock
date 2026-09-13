/**
 * The icon set: one inline SVG sprite, drawn here rather than pulled from a package.
 *
 * A dependency for twenty paths would be the largest thing in the bundle and would tie the look of
 * the app to someone else's release cadence. These are all built on the same grid — 24×24, 2px
 * stroke, round caps and joins — which is what makes them look like one family.
 *
 * Every icon inherits `currentColor` and sizes from its `size` prop, so an icon inside a button
 * needs no styling of its own. They are decorative: `aria-hidden` by default, because the control
 * around them always carries the real label.
 */

/* Paths only — every icon shares the same stroke treatment, applied once on the <svg>. */
const PATHS = {
  // Applications: four panes, the overview grid itself.
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  // Ports: traffic in both directions. Symmetric on purpose — at 16px an asymmetric pair of arrows
  // reads as a single hook rather than as two.
  ports: ['M4 9h16', 'M16 5l4 4-4 4', 'M20 15H4', 'M8 11l-4 4 4 4'],
  play: ['M7 4.5v15l12-7.5z'],
  // A square, not a filled circle: stop reads as "halt", and it pairs with play at the same weight.
  stop: ['M6.5 6.5h11v11h-11z'],
  restart: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M21 3v5h-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  pencil: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z', 'M14.5 6.5l3 3'],
  trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7', 'M10 11v6', 'M14 11v6'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M21 3v5h-5'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  terminal: ['M5 6l5 5-5 5', 'M12 18h7'],
  alert: ['M12 3 2.5 19.5h19L12 3z', 'M12 10v4', 'M12 17.5h.01'],
  chevron: ['M9 5l7 7-7 7'],
  external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  check: ['M4 12.5 9.5 18 20 6.5'],
};

/**
 * @param {{name: keyof PATHS, size?: number, className?: string, title?: string}} props
 *   `title` makes the icon meaningful to a screen reader; without it the icon is hidden, which is
 *   what you want whenever the surrounding control is already labelled.
 */
export default function Icon({ name, size = 16, className, title }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The product mark. Three lanes of different lengths in a rounded square — several processes,
 * running at once, in one enclosure. It is filled rather than stroked so it still reads at 16px in
 * a browser tab, and it is kept here so the favicon and the sidebar cannot drift apart.
 * @param {{size?: number}} props
 */
export function Logo({ size = 20 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g fill="var(--on-accent)" opacity="0.95">
        <rect x="7" y="9" width="18" height="3.5" rx="1.75" />
        <rect x="7" y="14.25" width="12" height="3.5" rx="1.75" />
        <rect x="7" y="19.5" width="15" height="3.5" rx="1.75" />
      </g>
    </svg>
  );
}
