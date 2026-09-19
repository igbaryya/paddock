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

const ACTION_VERBS = ['start', 'stop', 'restart'];
const ACTION_LABELS = { start: 'Start', stop: 'Stop', restart: 'Restart' };
const ACTION_ICONS = { start: 'play', stop: 'stop', restart: 'restart' };

/** @param {string} prefix */
function matchingVerbs(prefix) {
  const needle = prefix.toLowerCase();
  if (!needle) return [];
  return ACTION_VERBS.filter((verb) => verb.startsWith(needle));
}

/** @param {string} a @param {string} b */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return row[b.length];
}

/** @param {string} needle @param {string} hay */
function subsequence(needle, hay) {
  let index = 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  for (const ch of h) {
    if (ch === n[index]) index++;
    if (index === n.length) return true;
  }
  return false;
}

/** @param {string} head */
function fuzzyMatchingVerbs(head) {
  const needle = head.toLowerCase();
  if (needle.length < 3) return [];

  return ACTION_VERBS.map((verb) => ({ verb, dist: levenshtein(needle, verb) }))
    .filter(({ verb, dist }) => dist <= Math.max(2, Math.ceil(verb.length * 0.35)))
    .sort((a, b) => a.dist - b.dist || a.verb.localeCompare(b.verb))
    .map(({ verb }) => verb);
}

/** @param {string} needle @param {string} name @returns {number} legacy rank for open-ended service search */
function rankNameMatch(needle, name) {
  return rankNameMatchPercent(needle, name) * 1.1;
}

/** @param {string} needle @param {string} name @returns {number} 0–100 match strength */
function rankNameMatchPercent(needle, name) {
  const hay = name.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (hay === n) return 100;
  if (hay.startsWith(n)) return 95;
  if (hay.includes(n)) return 85;

  const dist = levenshtein(n, hay);
  const maxLen = Math.max(n.length, hay.length);
  const maxDist = Math.max(2, Math.ceil(maxLen * 0.45));
  if (subsequence(n, hay)) return Math.max(40, 78 - (dist / maxLen) * 38);
  if (dist <= maxDist) return Math.max(0, 58 - (dist / maxLen) * 38);
  return 0;
}

/** @param {string} appPart @param {string} servicePart @param {object} target */
function scoreScopedTarget(appPart, servicePart, target) {
  const appScore = rankNameMatchPercent(appPart, target.appName);
  const serviceScore = rankNameMatchPercent(servicePart, target.name);
  if (appScore === 0 && serviceScore === 0) return 0;

  if (appScore > 0 && serviceScore > 0) {
    const combined = appScore * 0.5 + serviceScore * 0.5;
    if (appScore >= 95 && serviceScore >= 95) return 100;
    if (appScore >= 80 && serviceScore >= 80) return Math.min(99, combined + 12);
    return combined;
  }

  // Only one side matched — keep these below any real app+service pair.
  return Math.max(appScore, serviceScore) * 0.39;
}

/** @param {string} needle @param {object} target */
function rankServiceMatch(needle, target) {
  const names = target.kind === 'process' ? [target.name, target.appName] : [target.name];
  return Math.max(...names.map((name) => rankNameMatch(needle, name)));
}

/** @param {string} word @returns {'start'|'stop'|'restart'|null} */
function resolveActionWord(word) {
  const lower = word.toLowerCase();
  if (ACTION_VERBS.includes(lower)) return /** @type {'start'|'stop'|'restart'} */ (lower);
  const fuzzy = fuzzyMatchingVerbs(word);
  if (fuzzy.length === 1) return fuzzy[0];
  return null;
}

/** @param {string} text */
function stripTrailingAction(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return { text: text.trim(), trailingAction: null };

  const trailing = resolveActionWord(parts[parts.length - 1]);
  if (!trailing) return { text: text.trim(), trailingAction: null };

  const rest = parts.slice(0, -1).join(' ').trim();
  if (!rest) return { text: text.trim(), trailingAction: null };
  return { text: rest, trailingAction: trailing };
}

/**
 * @param {string} text
 * @returns {{appPart: string, servicePart: string, separator: '::'|' ', trailingAction?: 'start'|'stop'|'restart'}|null}
 */
export function parseScope(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let appPart;
  let servicePart;
  let separator;

  if (trimmed.includes('::')) {
    const split = trimmed.split('::');
    appPart = split[0]?.trim();
    servicePart = split.slice(1).join('::').trim();
    separator = '::';
  } else {
    const space = trimmed.indexOf(' ');
    if (space === -1) return null;
    appPart = trimmed.slice(0, space).trim();
    servicePart = trimmed.slice(space + 1).trim();
    separator = ' ';
  }

  if (!appPart || !servicePart) return null;

  const { text: cleanedService, trailingAction } = stripTrailingAction(servicePart);
  if (!cleanedService) return null;

  return {
    appPart,
    servicePart: cleanedService,
    separator,
    ...(trailingAction ? { trailingAction } : {}),
  };
}

/** @param {string} query */
function looksLikeActionQuery(query) {
  const trimmed = query.trim();
  if (parseActionQuery(trimmed)) return true;

  const head = trimmed.match(/^(\S+)/)?.[1];
  if (!head) return false;
  return matchingVerbs(head).length > 0 || fuzzyMatchingVerbs(head).length > 0;
}

/**
 * @param {string} query
 * @returns {{appPart: string, servicePart: string, separator: '::'|' '}|null}
 */
function parseScopedServiceQuery(query) {
  if (looksLikeActionQuery(query)) return null;
  return parseScope(query.trim());
}

/** @param {string} appPart @param {string} servicePart @param {object[]} targets */
function filterScopedProcessTargets(targets, appPart, servicePart) {
  const ranked = targets
    .filter((target) => target.kind === 'process')
    .map((target) => ({
      target,
      score: scoreScopedTarget(appPart, servicePart, target),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.target.appName.localeCompare(b.target.appName) ||
        a.target.name.localeCompare(b.target.name)
    );

  const best = ranked[0]?.score ?? 0;
  if (best >= 90) return ranked.filter(({ score }) => score >= 90);
  if (best >= 40) return ranked.filter(({ score }) => score >= 40);
  return ranked.slice(0, 8);
}

/** @param {'start'|'stop'|'restart'} action @param {object} target @param {'::'|' '} separator */
function scopedActionCompletion(action, target, separator) {
  return separator === '::'
    ? `${action} ${target.appName}::${target.name}`
    : `${action} ${target.appName} ${target.name}`;
}

/** @param {object} target @param {'::'|' '} separator */
function scopedNavigateCompletion(target, separator) {
  return separator === '::' ? `${target.appName}::${target.name}` : `${target.appName} ${target.name}`;
}

/**
 * @param {string} query
 * @returns {{action: 'start'|'stop'|'restart', namePart: string, separator: '::'|' '}|null}
 */
export function parseActionQuery(query) {
  const trimmed = query.trim();
  /** @type {RegExpMatchArray|null} */
  let match = trimmed.match(/^(start|stop|restart)\s*::\s*(.*)$/i);
  if (match) {
    return {
      action: /** @type {'start'|'stop'|'restart'} */ (match[1].toLowerCase()),
      namePart: match[2].trim(),
      separator: '::',
    };
  }

  match = trimmed.match(/^(start|stop|restart)\s+(.*)$/i);
  if (match) {
    return {
      action: /** @type {'start'|'stop'|'restart'} */ (match[1].toLowerCase()),
      namePart: match[2].trim(),
      separator: ' ',
    };
  }

  return null;
}

/** @param {'start'|'stop'|'restart'} action @param {string} name @param {'::'|' '} separator */
function actionCompletion(action, name, separator) {
  return separator === '::' ? `${action}::${name}` : `${action} ${name}`;
}

/** @param {'start'|'stop'|'restart'} action @param {'::'|' '} [separator] @param {{suggested?: boolean}} [options] */
function buildVerbCompletion(action, separator = ' ', { suggested = false } = {}) {
  return {
    id: `complete-verb-${action}`,
    title: action,
    subtitle: suggested ? `Did you mean ${action}?` : 'Complete action',
    icon: ACTION_ICONS[action],
    group: 'Quick actions',
    completeOnly: true,
    suggested,
    completion: separator === '::' ? `${action}::` : `${action} `,
    run: () => {},
  };
}

/**
 * Full action syntax, or a partial verb prefix such as `re` → restart.
 *
 * @param {string} query
 */
export function parseFlexibleQuery(query) {
  const trimmed = query.trim();
  if (!trimmed) return { mode: 'search' };

  const full = parseActionQuery(trimmed);
  if (full) return { mode: 'action', verbComplete: true, ...full };

  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return { mode: 'search' };

  const head = match[1];
  const tail = (match[2] ?? '').trim();
  let fuzzyVerb = false;
  let verbs = matchingVerbs(head);
  if (!verbs.length) {
    verbs = fuzzyMatchingVerbs(head);
    fuzzyVerb = verbs.length > 0;
  }
  if (!verbs.length) return { mode: 'search' };

  if (verbs.length > 1) {
    return { mode: 'partial-multi', verbs, partialVerb: head, namePart: tail, fuzzyVerb };
  }

  const action = verbs[0];
  const verbComplete = !fuzzyVerb && head.toLowerCase() === action;
  return {
    mode: verbComplete ? 'action' : 'partial',
    action,
    partialVerb: head,
    namePart: tail,
    separator: ' ',
    verbComplete,
    fuzzyVerb,
  };
}

/** @param {object[]} applications */
export function buildServiceTargets(applications) {
  /** @type {object[]} */
  const targets = [];
  for (const app of applications) {
    targets.push({
      id: `app-${app.id}`,
      kind: 'application',
      name: app.name,
      applicationId: app.id,
      status: app.status,
    });
    for (const process of app.processes ?? []) {
      targets.push({
        id: `proc-${app.id}-${process.id}`,
        kind: 'process',
        name: process.name,
        applicationId: app.id,
        processId: process.id,
        appName: app.name,
        status: process.status,
      });
    }
  }
  return targets;
}

/**
 * Autocomplete rows for `start::`, `stop::`, and `restart::` quick actions.
 *
 * @param {{
 *   applications: object[],
 *   runApplication: (applicationId: string, action: string) => void,
 *   runProcess: (applicationId: string, processId: string, action: string) => void,
 * }} context
 */
function targetHaystack(target) {
  return target.kind === 'process'
    ? `${target.name} ${target.appName}`.toLowerCase()
    : target.name.toLowerCase();
}

export function buildActionCommands(
  action,
  namePart,
  { applications, runApplication, runProcess },
  separator = ' ',
  boostNeedle = null,
  fuzzyAction = false
) {
  const label = ACTION_LABELS[action];
  const icon = ACTION_ICONS[action];
  const scope = parseScope(namePart);
  const needle = namePart.toLowerCase();

  let targets = buildServiceTargets(applications);
  let suggested = fuzzyAction;
  let ranked = null;

  if (scope) {
    ranked = filterScopedProcessTargets(targets, scope.appPart, scope.servicePart);
    targets = ranked.map(({ target }) => target);
    suggested = fuzzyAction || ranked.some(({ score }) => score < 90);
  } else if (needle) {
    const exact = targets.filter((target) => targetHaystack(target).includes(needle));
    if (exact.length) {
      targets = exact;
    } else {
      targets = targets
        .map((target) => ({ target, score: rankServiceMatch(needle, target) }))
        .filter(({ score }) => score >= 30)
        .sort((a, b) => b.score - a.score || a.target.name.localeCompare(b.target.name))
        .map(({ target }) => target);
      suggested = targets.length > 0;
    }
  } else if (boostNeedle) {
    const boost = boostNeedle.toLowerCase();
    targets = [...targets].sort((a, b) => {
      const aMatch = targetHaystack(a).includes(boost);
      const bMatch = targetHaystack(b).includes(boost);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return targets.map((target) => {
    if (target.kind === 'process' && scope) {
      const completion = scopedActionCompletion(action, target, scope.separator);
      const mean = scopedActionCompletion(action, target, scope.separator);
      return {
        id: `${action}-proc-${target.processId}`,
        title: `${label} ${target.appName} › ${target.name}`,
        subtitle: suggested
          ? `Did you mean ${mean}? · ${target.status}`
          : `${target.appName} · ${target.status}`,
        icon,
        group: 'Quick actions',
        suggested,
        completion,
        run: () => runProcess(target.applicationId, target.processId, action),
      };
    }

    const completion = actionCompletion(action, target.name, separator);
    const mean = fuzzyAction ? `${action} ${target.name}` : target.name;
    if (target.kind === 'application') {
      return {
        id: `${action}-app-${target.applicationId}`,
        title: `${label} ${target.name}`,
        subtitle: suggested
          ? `Did you mean ${mean}? · Application · ${target.status}`
          : `Application · ${target.status}`,
        icon,
        group: 'Quick actions',
        suggested,
        completion,
        run: () => runApplication(target.applicationId, action),
      };
    }
    return {
      id: `${action}-proc-${target.processId}`,
      title: `${label} ${target.name}`,
      subtitle: suggested
        ? `Did you mean ${mean}? · ${target.appName} · ${target.status}`
        : `${target.appName} · ${target.status}`,
      icon,
      group: 'Quick actions',
      suggested,
      completion,
      run: () => runProcess(target.applicationId, target.processId, action),
    };
  });
}

/**
 * @param {{appPart: string, servicePart: string, separator: '::'|' '}} scope
 * @param {{target: object, score: number}[]} ranked
 * @param {{runProcess: Function}} context
 * @param {boolean} suggested
 */
function buildScopedActionCommands(scope, ranked, { runProcess }) {
  const topProcessId = ranked[0]?.target.processId ?? null;

  return ranked.flatMap(({ target, score }) =>
    ACTION_VERBS.map((action) => {
      const label = ACTION_LABELS[action];
      const completion = scopedActionCompletion(action, target, scope.separator);
      const suggested = score < 90;
      return {
        id: `${action}-scoped-${target.processId}`,
        title: `${label} ${target.appName} › ${target.name}`,
        subtitle: suggested ? `Did you mean ${completion}? · ${target.status}` : target.status,
        icon: ACTION_ICONS[action],
        group: 'Actions',
        suggested,
        preferred: Boolean(
          scope.trailingAction && action === scope.trailingAction && target.processId === topProcessId
        ),
        completion,
        run: () => runProcess(target.applicationId, target.processId, action),
      };
    })
  );
}

/**
 * @param {{appPart: string, servicePart: string, separator: '::'|' '}} scope
 * @param {{applications: object[], setIntent: Function, runProcess: Function}} context
 */
function buildScopedServiceCommands(scope, { applications, setIntent, runProcess }) {
  const targets = buildServiceTargets(applications);
  const ranked = filterScopedProcessTargets(targets, scope.appPart, scope.servicePart);

  const navigation = ranked.map(({ target, score }) => {
    const suggested = score < 90;
    return {
      id: `scope-${target.applicationId}-${target.processId}`,
      title: `${target.appName} › ${target.name}`,
      subtitle: suggested
        ? `Did you mean ${scopedNavigateCompletion(target, scope.separator)}? · ${target.status}`
        : `${target.appName} · ${target.status}`,
      icon: 'activity',
      group: 'Services',
      suggested,
      completion: scopedNavigateCompletion(target, scope.separator),
      run: () => {
        setIntent({ kind: 'drawer', applicationId: target.applicationId, processId: target.processId });
        navigate(paths.application(target.applicationId));
      },
    };
  });

  const actions = buildScopedActionCommands(scope, ranked, { runProcess });
  return [...navigation, ...actions];
}

/**
 * Action syntax takes over from plain search once `start::`, `stop::`, or `restart::` is typed.
 *
 * @param {object[]} commands
 * @param {string} query
 * @param {object|null} actionContext
 */
export function resolveCommands(commands, query, actionContext) {
  const scoped = parseScopedServiceQuery(query);
  if (scoped && actionContext?.setIntent && actionContext?.runProcess) {
    const scopedCommands = buildScopedServiceCommands(scoped, actionContext);
    if (scopedCommands.length) return scopedCommands;
  }

  const parsed = parseFlexibleQuery(query);
  if (parsed.mode === 'search' || !actionContext) {
    return filterCommands(commands, query);
  }

  if (parsed.mode === 'partial-multi') {
    if (parsed.namePart) {
      return parsed.verbs.flatMap((verb) =>
        buildActionCommands(
          verb,
          parsed.namePart,
          actionContext,
          ' ',
          null,
          parsed.fuzzyVerb
        )
      );
    }
    return parsed.verbs.map((verb) =>
      buildVerbCompletion(verb, ' ', { suggested: parsed.fuzzyVerb })
    );
  }

  const typingVerb = parsed.mode === 'partial' && !parsed.verbComplete && !parsed.namePart;
  const serviceNeedle = parsed.namePart || '';
  const boostNeedle = typingVerb ? parsed.partialVerb : null;
  const fuzzyAction = Boolean(parsed.fuzzyVerb && parsed.namePart);

  const serviceCommands = buildActionCommands(
    parsed.action,
    serviceNeedle,
    actionContext,
    parsed.separator ?? ' ',
    boostNeedle,
    fuzzyAction
  );

  if (parsed.mode === 'partial' && !parsed.verbComplete && !parsed.namePart) {
    return [
      ...serviceCommands,
      buildVerbCompletion(parsed.action, parsed.separator ?? ' ', { suggested: parsed.fuzzyVerb }),
    ];
  }

  return serviceCommands;
}

/** @param {object[]} commands */
export function pickPreferredCommandIndex(commands) {
  const preferred = commands.findIndex((command) => command.preferred);
  return preferred >= 0 ? preferred : 0;
}
