/**
 * An application's icon, the way the OS shows an app: a rounded tile. It carries the favicon its
 * services serve; a second, different favicon rides on its corner as a badge. An application with
 * none yet gets a tile of its own — PostgreSQL's own logo for a PostgreSQL server, the initial for a
 * group of processes — so two icon-less applications still look different at a glance.
 *
 * Favicons and logos are drawn for a background of their own choosing; the neutral tile behind each
 * one is what keeps a dark mark legible on the dark theme.
 */

/**
 * The favicons of the application's processes, one per distinct image: a web app and its admin
 * panel that ship the same favicon are one icon, not two identical ones.
 * @returns {{dataUrl: string, names: string[]}[]}
 */
function iconsOf(application, favicons) {
  const byImage = new Map();
  for (const process of application.processes) {
    const dataUrl = favicons[process.id]?.dataUrl;
    if (!dataUrl) continue;
    if (!byImage.has(dataUrl)) byImage.set(dataUrl, { dataUrl, names: [] });
    byImage.get(dataUrl).names.push(process.name);
  }
  return [...byImage.values()];
}

/** @param {{application: object}} props */
function Placeholder({ application }) {
  if (application.kind === 'postgres') return <img src="/postgres.svg" alt="" />;
  return application.name.trim().charAt(0).toUpperCase();
}

/**
 * Decorative: the name beside it already says what the application is, so the images have no alt
 * text and the process names ride on the tooltip instead.
 * @param {{application: object, favicons: Record<string, {dataUrl: string}>,
 *          size?: 'sm'|'md'|'lg'}} props
 */
export default function AppIcon({ application, favicons, size = 'lg' }) {
  const [primary, secondary] = iconsOf(application, favicons);
  return (
    <span className={`app-icon app-icon-${size}`} aria-hidden="true">
      {primary ? (
        <img src={primary.dataUrl} alt="" title={primary.names.join(', ')} />
      ) : (
        <Placeholder application={application} />
      )}
      {secondary && (
        <span className="app-icon-badge">
          <img src={secondary.dataUrl} alt="" title={secondary.names.join(', ')} />
        </span>
      )}
    </span>
  );
}
