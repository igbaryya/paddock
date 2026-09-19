/**
 * The icon set: Lucide's glyphs, behind the names the app already uses.
 *
 * Call sites name what an icon is for (`restart`, `ports`) rather than which glyph draws it, so the
 * glyph is chosen once, here, and swapping one never touches a component. Lucide is drawn on a
 * single grid — 24×24, 2px stroke, round caps and joins — which is what makes the set look like one
 * family, and only the glyphs imported below end up in the bundle.
 *
 * Every icon inherits `currentColor` and sizes from its `size` prop, so an icon inside a button
 * needs no styling of its own. They are decorative: `aria-hidden` by default, because the control
 * around them always carries the real label.
 */
import {
  Activity,
  ArrowDown,
  ArrowLeftRight,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clock,
  Copy,
  Database,
  ExternalLink,
  Folder,
  Globe,
  Info,
  LayoutGrid,
  Logs,
  Maximize,
  Minus,
  Monitor,
  Moon,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

const GLYPHS = {
  // Applications: four panes, the overview grid itself.
  grid: LayoutGrid,
  // Ports: traffic in both directions.
  ports: ArrowLeftRight,
  play: Play,
  // A square inside a ring: a bare outlined square beside a row's other actions reads as a checkbox.
  stop: CircleStop,
  // One arrow for bringing a process back up, two for re-reading data — they are different acts.
  restart: RotateCw,
  refresh: RefreshCw,
  plus: Plus,
  minus: Minus,
  // Fit: corners pushed outward, the gesture of sizing a view to what is in it.
  fit: Maximize,
  pencil: Pencil,
  trash: Trash2,
  search: Search,
  close: X,
  terminal: Terminal,
  // The application's own log tail, as opposed to a process's terminal glyph on a card.
  logs: Logs,
  // Pretty: the braces of the JSON record it reformats.
  braces: Braces,
  alert: TriangleAlert,
  // Points right: the ports table turns it a quarter to point down when a row is open.
  chevron: ChevronRight,
  external: ExternalLink,
  check: Check,
  copy: Copy,
  folder: Folder,
  back: ChevronLeft,
  'arrow-down': ArrowDown,
  // Activity: a pulse trace — something is alive, which is what "running" means on a summary.
  activity: Activity,
  clock: Clock,
  // Globe: reachable from beyond this machine.
  globe: Globe,
  power: Power,
  info: Info,
  database: Database,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  // Settings: sliders rather than a gear. A gear's teeth turn to noise at 16px.
  settings: SlidersHorizontal,
};

/**
 * @param {{name: keyof GLYPHS, size?: number, className?: string, title?: string}} props
 *   `title` makes the icon meaningful to a screen reader; without it the icon is hidden, which is
 *   what you want whenever the surrounding control is already labelled.
 */
export default function Icon({ name, size = 16, className, title }) {
  const Glyph = GLYPHS[name];
  if (!Glyph) return null;
  return (
    <Glyph
      className={className ? `icon ${className}` : 'icon'}
      size={size}
      strokeWidth={2}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      {title && <title>{title}</title>}
    </Glyph>
  );
}

/**
 * The product mark — a P and a live dot (see public/favicon.svg). It is the favicon file itself
 * rather than a copy of its paths, so the tab, the sidebar and the desktop app's icons, which are
 * rendered from that same file, cannot drift apart. It keeps its own colours in both themes: it is
 * the brand, not chrome.
 * @param {{size?: number}} props
 */
export function Logo({ size = 20 }) {
  return <img className="logo" src="/favicon.svg" width={size} height={size} alt="" />;
}
