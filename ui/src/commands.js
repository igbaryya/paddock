/**
 * Everything the command palette can jump to or do.
 *
 * Built fresh whenever the palette opens so the list always matches what is on the machine right
 * now. Commands delegate to the same handlers App uses everywhere else — no second copy of the
 * action logic.
 */
import { navigate, paths } from './router.jsx';
import { setThemePreference } from './useTheme.js';

/** @param {object} app */
function appSummary(app) {
  const counts = app.processCounts;
  return `${counts.running}/${counts.enabled} running · ${counts.total} configured`;
}

/**
 * @param {{
 *   applications: object[],
 *   route: object,
 *   selected: object|null,
 *   setIntent: (intent: object|null) => void,
 *   openApplicationForm: (application?: object|null) => void,
 *   refreshPorts: (options?: object) => void,
 * }} context
 * @returns {object[]}
 */
export function buildCommands({
  applications,
  route,
  selected,
  setIntent,
  openApplicationForm,
  refreshPorts,
}) {
  /** @type {object[]} */
  const commands = [];

  commands.push({
    id: 'nav-overview',
    title: 'Applications',
    subtitle: 'Overview of all applications and their status.',
    icon: 'grid',
    keywords: 'home overview dashboard',
    group: 'Pages',
    run: () => navigate(paths.overview()),
  });

  commands.push({
    id: 'nav-ports',
    title: 'Local ports',
    subtitle: 'Every listening TCP port on this machine.',
    icon: 'ports',
    keywords: 'ports tcp network',
    group: 'Pages',
    run: () => navigate(paths.ports()),
  });

  commands.push({
    id: 'nav-settings',
    title: 'Settings',
    subtitle: 'Theme, start at login, and install paths.',
    icon: 'settings',
    keywords: 'preferences config',
    group: 'Pages',
    run: () => navigate(paths.settings()),
  });

  for (const app of applications) {
    commands.push({
      id: `app-${app.id}`,
      title: app.name,
      subtitle: `Applications · ${appSummary(app)}`,
      icon: app.kind === 'postgres' ? 'database' : 'grid',
      keywords: `${app.id} ${app.kind} ${app.status}`,
      group: 'Applications',
      run: () => navigate(paths.application(app.id)),
    });

    commands.push({
      id: `app-${app.id}-logs`,
      title: `Open logs — ${app.name}`,
      subtitle: 'Full-window log tail for every process.',
      icon: 'logs',
      keywords: `${app.name} logs output tail`,
      group: 'Actions',
      run: () => {
        setIntent({ kind: 'logs', applicationId: app.id });
        navigate(paths.application(app.id));
      },
    });

    commands.push({
      id: `app-${app.id}-terminal`,
      title: `Open terminal — ${app.name}`,
      subtitle: "Shell in one of this application's repositories.",
      icon: 'terminal',
      keywords: `${app.name} terminal shell`,
      group: 'Actions',
      run: () => {
        setIntent({ kind: 'terminal', applicationId: app.id });
        navigate(paths.application(app.id));
      },
    });

    for (const process of app.processes ?? []) {
      commands.push({
        id: `proc-${app.id}-${process.id}`,
        title: process.name,
        subtitle: `${app.name} · ${process.status}${process.cwd ? ` · ${process.cwd}` : ''}`,
        icon: 'activity',
        keywords: `${app.name} ${process.id} ${process.command ?? ''}`,
        group: 'Processes',
        run: () => {
          setIntent({ kind: 'drawer', applicationId: app.id, processId: process.id });
          navigate(paths.application(app.id));
        },
      });
    }
  }

  commands.push({
    id: 'action-new-app',
    title: 'New application',
    subtitle: 'Create a new application to manage.',
    icon: 'plus',
    keywords: 'create add',
    group: 'Actions',
    run: () => openApplicationForm(),
  });

  if (route.name === 'application' && selected) {
    commands.push({
      id: 'action-edit-app',
      title: `Edit ${selected.name}`,
      subtitle: 'Change name, repositories, or auto-start.',
      icon: 'pencil',
      keywords: 'edit configuration',
      group: 'Actions',
      run: () => openApplicationForm(selected),
    });
  }

  commands.push({
    id: 'action-refresh-ports',
    title: 'Refresh ports',
    subtitle: 'Re-scan listening TCP ports on this machine.',
    icon: 'refresh',
    keywords: 'ports scan reload',
    group: 'Actions',
    run: () => refreshPorts({ force: true }),
  });

  for (const theme of ['system', 'light', 'dark']) {
    commands.push({
      id: `theme-${theme}`,
      title: `Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`,
      subtitle: 'Appearance for this dashboard.',
      icon: theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor',
      keywords: 'theme appearance dark light',
      group: 'Settings',
      run: () => setThemePreference(theme),
    });
  }

  return commands;
}

/**
 * @param {object[]} commands
 * @param {string} query
 */
export function filterCommands(commands, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => {
    const haystack = `${command.title} ${command.subtitle} ${command.keywords ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}
