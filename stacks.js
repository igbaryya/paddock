/**
 * What kind of project a directory holds, and the commands that usually start one — for the process
 * form, which otherwise only has package.json scripts to offer and so has nothing at all to say about
 * a Python service, a Go binary, or a Vite app whose author never wrote a `dev` script.
 *
 * Every suggestion is inferred from files the directory already has: a manifest, a lockfile, a
 * wrapper script, or an application object found in a well-known entry file. Nothing is executed and
 * nothing is installed to find out. A suggestion is a click that fills the Command field, never a
 * default, because an inference can be wrong in ways a declared script cannot.
 *
 * Which files may be read is fixed here, and the only ones beyond fixed names are entries of
 * directories this module lists itself (`cmd/<name>/main.go`, `requirements-dev.txt`). Their
 * contents never leave this module: what the caller gets back is a label, the names of the files
 * that gave the stack away, and commands built from constants and those names.
 *
 * Detectors are independent and every one is allowed to find nothing. A repository with a Node
 * front end, a Python API and a compose file is three stacks, and each is reported.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as platform from './platform/index.js';

const MAX_MANIFEST_BYTES = 262_144;
/**
 * How much of an entry file is searched for its application object. A service's main module can
 * run to hundreds of kilobytes of routes, but the object those routes hang off is defined near the
 * top, so the file is read only this far rather than skipped for being long.
 */
const MAX_SOURCE_HEAD_BYTES = 524_288;
const MAX_SUGGESTIONS_PER_STACK = 8;
const MAX_SUGGESTIONS = 24;
const MAX_REQUIREMENTS_FILES = 5;
const MAX_GO_COMMANDS = 6;

/** Script names that start something, as opposed to building, testing or linting it. */
const RUN_SCRIPTS = ['dev', 'start', 'serve', 'develop', 'server'];

/** Make, just and Task targets worth offering: the same idea as `RUN_SCRIPTS`, in their vocabulary. */
const RUN_TARGETS = new Set(['dev', 'start', 'run', 'serve', 'server', 'up', 'watch', 'develop']);

/** How each package manager runs a dependency's binary without a script to name it. */
const EXEC = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };

/**
 * Dependency → framework and the binary that serves it in development. The first match wins, so
 * the order matters: a Next.js app also depends on react, and a SvelteKit app also depends on vite.
 */
const NODE_FRAMEWORKS = [
  { dep: 'next', label: 'Next.js', run: 'next dev' },
  { dep: 'nuxt', label: 'Nuxt', run: 'nuxt dev' },
  { dep: '@react-router/dev', label: 'React Router', run: 'react-router dev' },
  { dep: '@sveltejs/kit', label: 'SvelteKit', run: 'vite dev' },
  { dep: 'astro', label: 'Astro', run: 'astro dev' },
  { dep: '@angular/cli', label: 'Angular', run: 'ng serve' },
  { dep: 'gatsby', label: 'Gatsby', run: 'gatsby develop' },
  { dep: '@nestjs/cli', label: 'NestJS', run: 'nest start --watch' },
  { dep: 'expo', label: 'Expo', run: 'expo start' },
  { dep: 'react-scripts', label: 'Create React App', run: 'react-scripts start' },
  { dep: '@vue/cli-service', label: 'Vue CLI', run: 'vue-cli-service serve' },
  { dep: 'vite', label: 'Vite', run: 'vite' },
  { dep: 'webpack-dev-server', label: 'webpack', run: 'webpack serve' },
  { dep: 'electron', label: 'Electron', run: 'electron .' },
];

/** What a bundler is bundling, so "Vite" can read as "React (Vite)". */
const UI_LIBRARIES = [
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact'],
  ['lit', 'Lit'],
];

/** Server libraries have no dev binary of their own; they are started by running the entry file. */
const NODE_SERVERS = [
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['@hapi/hapi', 'hapi'],
  ['hono', 'Hono'],
  ['@nestjs/core', 'NestJS'],
];

const SCRIPT_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.cjs'];
const ENTRY_STEMS = ['server', 'index', 'main', 'app'];
const isTypeScript = (file) => /\.[mc]?ts$/.test(file);

const PYTHON_MARKERS = [
  'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg', 'manage.py',
  'uv.lock', 'poetry.lock', 'pdm.lock',
];
const PYTHON_ENTRIES = ['main.py', 'app.py', 'server.py', 'run.py', 'api.py', 'wsgi.py', 'asgi.py'];

/** Where an ASGI or WSGI application object is usually defined, in the order to look. */
const PYTHON_APP_FILES = [
  'main.py', 'app.py', 'server.py', 'api.py', 'asgi.py', 'wsgi.py',
  'app/main.py', 'app/app.py', 'app/__init__.py', 'api/main.py', 'src/main.py', 'src/app.py',
];

/**
 * `app = FastAPI(` and its relatives, annotated or not. Anchored at a line start so a commented-out
 * or indented assignment inside a function is not mistaken for the module's application.
 */
const PYTHON_APP_OBJECT =
  /^(\w+)\s*(?::\s*[\w.[\], ]+)?=\s*(?:\w+\.)?(FastAPI|Starlette|Litestar|Flask|Quart|Sanic)\s*\(/m;

const ASGI = new Set(['FastAPI', 'Starlette', 'Litestar', 'Quart']);

/** Named by a manifest but not found as an application object: still worth saying what it is. */
const PYTHON_FRAMEWORKS = [
  ['django', 'Django'],
  ['fastapi', 'FastAPI'],
  ['flask', 'Flask'],
  ['streamlit', 'Streamlit'],
  ['gradio', 'Gradio'],
];

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const MAKEFILES = ['GNUmakefile', 'Makefile', 'makefile'];
const JUSTFILES = ['justfile', 'Justfile', '.justfile'];
const TASKFILES = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'];
const PROCFILES = ['Procfile', 'Procfile.dev'];

/** A bounded read that answers null for anything it would not read, rather than throwing. */
async function readText(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** The start of a file, however long it is — null for anything that is not a readable file. */
async function readHead(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Quoted only when it has to be. Double quotes mean the same thing to `sh` and to `cmd` for a path,
 * and a command that is quoted for no reason reads as though something about it were unusual.
 */
const quoteArg = (arg) => (/^[\w./:@=+-]+$/.test(arg) ? arg : `"${arg}"`);

/** A relative path as both shells will read it: forward slashes are accepted by `cmd` too. */
const posixPath = (relative) => relative.split(path.sep).join('/');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a Python manifest names a distribution. Loose on purpose — requirements files, Pipfiles,
 * setup.py and pyproject.toml all spell a dependency differently — but bounded by characters a
 * distribution name cannot contain, so `django` does not match `django-environ` or `my-django`.
 */
const mentions = (text, name) =>
  new RegExp(`(^|[^a-z0-9_.-])${escapeRegExp(name)}($|[^a-z0-9_.-])`, 'm').test(text);

/**
 * The keys of one TOML table, read line by line — enough for `[project.scripts]` without a TOML
 * parser, because the only thing wanted from it is names.
 */
function tomlKeys(text, header) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start === -1) return [];
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*["']?([\w.-]+)["']?\s*=/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * JSON with comments and trailing commas, as deno.jsonc allows. Comments are only stripped outside
 * strings, so an import map full of `https://` URLs survives.
 */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[(i += 1)] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Everything a detector may ask about the directory. Reads and listings are memoised for the one
 * inspection, because several detectors look at the same handful of files.
 */
function directoryContext(dir, names, pkg, manager) {
  const present = new Set(names);
  const reads = new Map();
  const heads = new Map();
  const listings = new Map();
  const read = (relative) => {
    if (!reads.has(relative)) reads.set(relative, readText(path.join(dir, relative)));
    return reads.get(relative);
  };
  const readSourceHead = (relative) => {
    if (!heads.has(relative)) heads.set(relative, readHead(path.join(dir, relative), MAX_SOURCE_HEAD_BYTES));
    return heads.get(relative);
  };
  const list = (relative) => {
    if (!listings.has(relative)) {
      listings.set(relative, readdir(path.join(dir, relative)).catch(() => []));
    }
    return listings.get(relative);
  };
  /** Whether a relative path exists, answered from listings so no stat is spent on a guess. */
  const has = async (relative) => {
    const parts = posixPath(relative).split('/');
    const name = parts.pop();
    return parts.length ? (await list(parts.join('/'))).includes(name) : present.has(name);
  };
  const first = (candidates) => candidates.find((name) => present.has(name)) ?? null;
  return { dir, names, present, read, readSourceHead, list, has, first, pkg, manager };
}

const suggestion = (command, reason) => ({ command, reason });

/** The first of `candidates` that exists, checked in order. */
async function firstExisting(ctx, candidates) {
  for (const candidate of candidates) {
    if (await ctx.has(candidate)) return candidate;
  }
  return null;
}

// --- Node.js -------------------------------------------------------------------------------------

/** The file a Node service starts from: `main` when the package names one, else the usual names. */
async function nodeEntry(ctx) {
  const main = ctx.pkg?.main;
  if (main) {
    const relative = path.normalize(main);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && (await ctx.has(relative))) {
      return posixPath(relative);
    }
  }
  const candidates = ['', 'src/'].flatMap((dir) =>
    ENTRY_STEMS.flatMap((stem) => SCRIPT_EXTENSIONS.map((ext) => `${dir}${stem}${ext}`))
  );
  return firstExisting(ctx, candidates);
}

/**
 * How to run one entry file in development. TypeScript goes through tsx unless the project already
 * chose another runner — tsx needs no tsconfig changes and `npx` fetches it when it is missing.
 */
function runEntry(file, deps, exec, manager) {
  const arg = quoteArg(file);
  if (manager === 'bun') return [`bun --watch ${arg}`];
  if (isTypeScript(file)) {
    if (deps.has('ts-node-dev')) return [`${exec} ts-node-dev --respawn ${arg}`];
    if (deps.has('ts-node') && !deps.has('tsx')) return [`${exec} ts-node ${arg}`];
    return [`${exec} tsx watch ${arg}`];
  }
  if (deps.has('nodemon')) return [`${exec} nodemon ${arg}`, `node ${arg}`];
  return [`node --watch ${arg}`, `node ${arg}`];
}

function nodeFramework(deps) {
  const framework = NODE_FRAMEWORKS.find(({ dep }) => deps.has(dep));
  if (!framework) return null;
  if (framework.dep !== 'vite' && framework.dep !== 'webpack-dev-server') return framework;
  const library = UI_LIBRARIES.find(([dep]) => deps.has(dep));
  return library ? { ...framework, label: `${library[1]} (${framework.label})` } : framework;
}

/**
 * A package.json, or JavaScript and TypeScript files without one. Suggestions are only made when
 * the package declares no script that starts anything: a project that has a `dev` script has
 * already said how it starts, and the form offers that script above everything here.
 */
async function detectNode(ctx) {
  const { pkg } = ctx;
  if (!pkg && (ctx.present.has('deno.json') || ctx.present.has('deno.jsonc'))) return null;

  const deps = pkg?.dependencies ?? new Set();
  const entry = await nodeEntry(ctx);
  if (!pkg && !entry) return null;

  const typescript = ctx.present.has('tsconfig.json') || deps.has('typescript') || isTypeScript(entry ?? '');
  const framework = nodeFramework(deps);
  const server = NODE_SERVERS.find(([dep]) => deps.has(dep))?.[1] ?? null;
  const details = [typescript ? 'TypeScript' : 'JavaScript', framework?.label ?? server].filter(Boolean);
  const evidence = [pkg ? 'package.json' : entry, ctx.present.has('tsconfig.json') ? 'tsconfig.json' : null];

  const notes = [];
  if (pkg && !ctx.present.has('node_modules')) {
    notes.push(`Dependencies are not installed — run ${ctx.manager} install once before starting it.`);
  }

  const declared = pkg && RUN_SCRIPTS.some((name) => typeof pkg.scripts[name] === 'string');
  const exec = EXEC[ctx.manager] ?? 'npx';
  const suggestions = [];
  if (!declared && framework) {
    suggestions.push(suggestion(`${exec} ${framework.run}`, `${framework.dep} is a dependency`));
  }
  if (!declared && entry && !framework) {
    const why = server ? `${server} server; ${entry} is the entry file` : `${entry} is the entry file`;
    for (const command of runEntry(entry, deps, exec, ctx.manager)) suggestions.push(suggestion(command, why));
  }

  return { id: 'node', label: 'Node.js', details, evidence: evidence.filter(Boolean), notes, suggestions };
}

// --- Deno ----------------------------------------------------------------------------------------

async function detectDeno(ctx) {
  const file = ctx.first(['deno.json', 'deno.jsonc']);
  if (!file) return null;
  let tasks = {};
  try {
    const parsed = parseJsonc((await ctx.read(file)) ?? '{}');
    if (parsed && typeof parsed.tasks === 'object' && parsed.tasks !== null) tasks = parsed.tasks;
  } catch {
    // A deno.json that will not parse still says this is a Deno project; it just names no tasks.
  }

  const rank = (name) => (RUN_SCRIPTS.includes(name) ? RUN_SCRIPTS.indexOf(name) : RUN_SCRIPTS.length);
  const suggestions = Object.keys(tasks)
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => suggestion(`deno task ${name}`, `task declared in ${file}`));

  if (!suggestions.length) {
    const entry = await firstExisting(ctx, ['main.ts', 'server.ts', 'mod.ts', 'src/main.ts']);
    if (entry) suggestions.push(suggestion(`deno run --watch -A ${entry}`, `${entry} is the entry file`));
  }
  return { id: 'deno', label: 'Deno', details: ['TypeScript'], evidence: [file], notes: [], suggestions };
}

// --- Python --------------------------------------------------------------------------------------

/**
 * What runs `python` for this project. A project tool's lockfile or table wins, because it is what
 * the author installs with; then a virtual environment sitting in the directory; then whatever
 * interpreter is on PATH, which is the one most likely to be missing the dependencies.
 */
async function pythonRunner(ctx, pyproject) {
  const tools = [
    ['uv', 'uv.lock', 'tool.uv'],
    ['poetry', 'poetry.lock', 'tool.poetry'],
    ['pdm', 'pdm.lock', 'tool.pdm'],
  ];
  for (const [tool, lockfile, table] of tools) {
    if (ctx.present.has(lockfile) || pyproject.includes(`[${table}]`)) {
      return { tool, python: `${tool} run python`, bin: (name) => `${tool} run ${name}` };
    }
  }
  if (ctx.present.has('Pipfile')) {
    return { tool: 'pipenv', python: 'pipenv run python', bin: (name) => `pipenv run ${name}` };
  }
  for (const venv of ['.venv', 'venv', 'env']) {
    if (!ctx.present.has(venv)) continue;
    const python = platform.venvPython(venv);
    if (await ctx.has(python)) {
      return { tool: venv, python, bin: (name) => path.join(path.dirname(python), name) };
    }
  }
  return { tool: null, python: platform.pythonCommand, bin: null };
}

/**
 * The first well-known file that defines an application object, and what that object is. A `src/`
 * with an `__init__.py` is a package in its own right — its modules import each other as `.utils`
 * — so it is imported as `src.main` from the project, not as `main` from inside it.
 */
async function pythonApp(ctx) {
  for (const file of PYTHON_APP_FILES) {
    if (!(await ctx.has(file))) continue;
    const match = PYTHON_APP_OBJECT.exec((await ctx.readSourceHead(file)) ?? '');
    if (!match) continue;
    const srcPackage = file.startsWith('src/') && (await ctx.has('src/__init__.py'));
    return { file, variable: match[1], kind: match[2], srcPackage };
  }
  return null;
}

/**
 * The command for an application object. ASGI apps go through uvicorn, which FastAPI's own
 * `[standard]` extra installs; Flask through its CLI, given the file path so a `src/` layout works
 * without an install. Everything is `python -m`, so the runner's interpreter — and therefore its
 * environment — is the one that imports the app.
 */
function pythonAppCommand({ file, variable, kind, srcPackage }, python, port) {
  const importPath = srcPackage ? file : file.replace(/^src\//, '');
  const module = importPath.replace(/(\/__init__)?\.py$/, '').replaceAll('/', '.');
  const why = `${kind} application "${variable}" in ${file}`;
  if (ASGI.has(kind)) {
    const appDir = file.startsWith('src/') && !srcPackage ? ' --app-dir src' : '';
    const portArg = port ? ` --port ${port}` : '';
    const reason = port ? `${why}; port ${port} as the Dockerfile runs it` : why;
    return suggestion(`${python} -m uvicorn ${module}:${variable} --reload${portArg}${appDir}`, reason);
  }
  if (kind === 'Sanic') return suggestion(`${python} -m sanic ${module}:${variable} --dev`, why);
  // Flask finds `app` and `application` by itself; any other name has to be spelled out. A file path
  // is imported as a top-level module, so a package's app is named by its import path instead.
  const where = srcPackage ? module : file;
  const target = variable === 'app' || variable === 'application' ? where : `${where}:${variable}`;
  return suggestion(`${python} -m flask --app ${target} run --debug`, why);
}

/**
 * The port the project's own Dockerfile serves its ASGI app on, so a local run listens where the
 * rest of the system already expects it rather than on uvicorn's default.
 */
async function dockerfileAsgiPort(ctx) {
  if (!ctx.present.has('Dockerfile')) return null;
  const command = ((await ctx.read('Dockerfile')) ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(line) && /\b(?:uvicorn|hypercorn|gunicorn)\b/.test(line))
    .at(-1);
  const match = command && /--port["',\s=]+(\d{2,5})\b|--bind["',\s=]+[^:"'\s]*:(\d{2,5})\b/.exec(command);
  const port = match ? Number(match[1] ?? match[2]) : null;
  return port && port < 65_536 ? port : null;
}

async function requirementsText(ctx) {
  const files = ctx.names.filter((name) => /^requirements.*\.(txt|in)$/i.test(name)).slice(0, MAX_REQUIREMENTS_FILES);
  return { files, text: (await Promise.all(files.map((name) => ctx.read(name)))).join('\n') };
}

async function detectPython(ctx) {
  const requirements = await requirementsText(ctx);
  const markers = PYTHON_MARKERS.filter((name) => ctx.present.has(name));
  const entries = PYTHON_ENTRIES.filter((name) => ctx.present.has(name));
  if (!markers.length && !requirements.files.length && !entries.length) return null;

  const pyproject = (await ctx.read('pyproject.toml')) ?? '';
  const manifests = [
    pyproject,
    requirements.text,
    (await ctx.read('Pipfile')) ?? '',
    (await ctx.read('setup.py')) ?? '',
    (await ctx.read('setup.cfg')) ?? '',
  ].join('\n').toLowerCase();

  const runner = await pythonRunner(ctx, pyproject);
  const { python } = runner;
  const suggestions = [];
  let framework = null;

  if (ctx.present.has('manage.py')) {
    framework = 'Django';
    suggestions.push(suggestion(`${python} manage.py runserver`, 'manage.py is a Django project'));
  }

  const app = framework ? null : await pythonApp(ctx);
  if (app) {
    framework = app.kind;
    suggestions.push(pythonAppCommand(app, python, await dockerfileAsgiPort(ctx)));
  }

  if (!framework && mentions(manifests, 'streamlit')) {
    const entry = await firstExisting(ctx, ['streamlit_app.py', 'app.py', 'main.py', 'Home.py']);
    if (entry) {
      framework = 'Streamlit';
      suggestions.push(suggestion(`${python} -m streamlit run ${entry}`, `streamlit is a dependency; ${entry} is the app`));
    }
  }

  if (runner.bin) {
    for (const name of [...tomlKeys(pyproject, 'project.scripts'), ...tomlKeys(pyproject, 'tool.poetry.scripts')]) {
      suggestions.push(suggestion(runner.bin(name), 'console script declared in pyproject.toml'));
    }
  }

  for (const entry of entries) {
    if (entry === 'wsgi.py' || entry === 'asgi.py') continue;
    if (app?.file === entry) continue;
    suggestions.push(suggestion(`${python} ${entry}`, `${entry} is at the top of the project`));
  }

  framework ??= PYTHON_FRAMEWORKS.find(([name]) => mentions(manifests, name))?.[1] ?? null;

  const notes = [];
  if (!runner.tool && (markers.length || requirements.files.length)) {
    notes.push(`No virtual environment here, so these run the ${python} on PATH — it needs the dependencies installed.`);
  }

  return {
    id: 'python',
    label: 'Python',
    details: [runner.tool, framework].filter(Boolean),
    evidence: [...new Set([...markers, ...requirements.files])].slice(0, 6),
    notes,
    suggestions,
  };
}

// --- Go, Rust, JVM, Ruby, PHP, .NET, Elixir --------------------------------------------------------

async function detectGo(ctx) {
  if (!ctx.present.has('go.mod')) return null;
  const mod = (await ctx.read('go.mod')) ?? '';
  const framework = [
    ['github.com/gin-gonic/gin', 'Gin'],
    ['github.com/labstack/echo', 'Echo'],
    ['github.com/gofiber/fiber', 'Fiber'],
    ['github.com/go-chi/chi', 'chi'],
  ].find(([module]) => mod.includes(module))?.[1];

  const suggestions = [];
  if (ctx.present.has('.air.toml')) suggestions.push(suggestion('air', '.air.toml configures live reload'));
  if (ctx.present.has('main.go')) suggestions.push(suggestion('go run .', 'main.go is at the top of the module'));
  const commands = (await ctx.list('cmd')).slice(0, 50);
  for (const name of commands) {
    if (suggestions.length >= MAX_GO_COMMANDS) break;
    if (await ctx.has(`cmd/${name}/main.go`)) {
      suggestions.push(suggestion(`go run ./${posixPath(path.join('cmd', name))}`, `cmd/${name}/main.go is a main package`));
    }
  }
  return { id: 'go', label: 'Go', details: [framework].filter(Boolean), evidence: ['go.mod'], notes: [], suggestions };
}

async function detectRust(ctx) {
  if (!ctx.present.has('Cargo.toml')) return null;
  const manifest = (await ctx.read('Cargo.toml')) ?? '';
  const framework = [['actix-web', 'Actix Web'], ['axum', 'Axum'], ['rocket', 'Rocket'], ['warp', 'warp']]
    .find(([crate]) => new RegExp(`^\\s*${escapeRegExp(crate)}\\s*=`, 'm').test(manifest))?.[1];

  // A virtual workspace has members and no package of its own, so there is nothing for `cargo run` to run.
  const suggestions = [];
  if (/^\[package\]/m.test(manifest)) {
    suggestions.push(suggestion('cargo run', 'Cargo.toml declares a package'));
    for (const file of (await ctx.list('src/bin')).filter((name) => name.endsWith('.rs')).slice(0, 5)) {
      suggestions.push(suggestion(`cargo run --bin ${file.slice(0, -3)}`, `src/bin/${file} is a binary target`));
    }
  }
  return { id: 'rust', label: 'Rust', details: [framework].filter(Boolean), evidence: ['Cargo.toml'], notes: [], suggestions };
}

async function detectJvm(ctx) {
  const gradle = ctx.first(['build.gradle.kts', 'build.gradle']);
  const maven = ctx.present.has('pom.xml');
  if (!gradle && !maven) return null;

  const build = ((await ctx.read(gradle ?? 'pom.xml')) ?? '').toLowerCase();
  const framework = build.includes('spring-boot') || build.includes('org.springframework.boot')
    ? 'Spring Boot'
    : build.includes('quarkus')
      ? 'Quarkus'
      : build.includes('micronaut')
        ? 'Micronaut'
        : null;
  const kotlin = gradle === 'build.gradle.kts' || build.includes('kotlin');

  const suggestions = [];
  if (gradle) {
    const tool = ctx.present.has('gradlew') ? platform.localCommand('gradlew') : 'gradle';
    const task = { 'Spring Boot': 'bootRun', Quarkus: 'quarkusDev', Micronaut: 'run' }[framework]
      ?? (/\bapplication\b/.test(build) ? 'run' : null);
    if (task) suggestions.push(suggestion(`${tool} ${task}`, `${framework ?? 'application plugin'} in ${gradle}`));
  } else {
    const tool = ctx.present.has('mvnw') ? platform.localCommand('mvnw') : 'mvn';
    const goal = { 'Spring Boot': 'spring-boot:run', Quarkus: 'quarkus:dev', Micronaut: 'mn:run' }[framework];
    if (goal) suggestions.push(suggestion(`${tool} ${goal}`, `${framework} in pom.xml`));
  }
  return {
    id: 'jvm',
    label: kotlin ? 'Kotlin' : 'Java',
    details: [gradle ? 'Gradle' : 'Maven', framework].filter(Boolean),
    evidence: [gradle ?? 'pom.xml'],
    notes: [],
    suggestions,
  };
}

async function detectRuby(ctx) {
  if (!ctx.present.has('Gemfile')) return null;
  const gemfile = (await ctx.read('Gemfile')) ?? '';
  const gem = (name) => new RegExp(`^\\s*gem\\s+["']${escapeRegExp(name)}["']`, 'm').test(gemfile);

  const suggestions = [];
  let framework = null;
  if (gem('rails')) {
    framework = 'Rails';
    suggestions.push(suggestion('bundle exec rails server', 'rails is in the Gemfile'));
  } else if (gem('sinatra') && ctx.present.has('app.rb')) {
    framework = 'Sinatra';
    suggestions.push(suggestion('bundle exec ruby app.rb', 'sinatra is in the Gemfile'));
  }
  if (!framework && ctx.present.has('config.ru')) {
    suggestions.push(suggestion('bundle exec rackup', 'config.ru is a Rack application'));
  }
  return { id: 'ruby', label: 'Ruby', details: [framework].filter(Boolean), evidence: ['Gemfile'], notes: [], suggestions };
}

async function detectPhp(ctx) {
  const composer = ctx.present.has('composer.json');
  if (!composer && !ctx.present.has('index.php') && !ctx.present.has('artisan')) return null;

  const suggestions = [];
  let framework = null;
  if (ctx.present.has('artisan')) {
    framework = 'Laravel';
    suggestions.push(suggestion('php artisan serve', 'artisan is a Laravel project'));
  } else if (await ctx.has('public/index.php')) {
    if (ctx.present.has('symfony.lock')) framework = 'Symfony';
    suggestions.push(suggestion('php -S localhost:8000 -t public', 'public/index.php is the front controller'));
  } else if (ctx.present.has('index.php')) {
    suggestions.push(suggestion('php -S localhost:8000', 'index.php is at the top of the project'));
  }
  return {
    id: 'php',
    label: 'PHP',
    details: [framework].filter(Boolean),
    evidence: [composer ? 'composer.json' : ctx.first(['artisan', 'index.php'])],
    notes: [],
    suggestions,
  };
}

async function detectDotnet(ctx) {
  const project = ctx.names.find((name) => /\.(cs|fs|vb)proj$/.test(name));
  if (!project) return null;
  const language = { cs: 'C#', fs: 'F#', vb: 'Visual Basic' }[project.slice(-6, -4)];
  return {
    id: 'dotnet',
    label: '.NET',
    details: [language].filter(Boolean),
    evidence: [project],
    notes: [],
    suggestions: [
      suggestion('dotnet watch run', `${project} is a project file`),
      suggestion('dotnet run', `${project} is a project file`),
    ],
  };
}

async function detectElixir(ctx) {
  if (!ctx.present.has('mix.exs')) return null;
  const phoenix = /:phoenix\b/.test((await ctx.read('mix.exs')) ?? '');
  return {
    id: 'elixir',
    label: 'Elixir',
    details: phoenix ? ['Phoenix'] : [],
    evidence: ['mix.exs'],
    notes: [],
    suggestions: [
      phoenix
        ? suggestion('mix phx.server', 'phoenix is a dependency in mix.exs')
        : suggestion('mix run --no-halt', 'mix.exs'),
    ],
  };
}

// --- Declared process and task runners -----------------------------------------------------------

/**
 * A Procfile names each process and its command, which is exactly what a Paddock process is — so
 * each entry is offered as it stands rather than through foreman.
 */
async function detectProcfile(ctx) {
  const files = PROCFILES.filter((name) => ctx.present.has(name));
  if (!files.length) return null;
  const suggestions = [];
  for (const file of files) {
    for (const [, name, command] of ((await ctx.read(file)) ?? '').matchAll(/^([\w-]+):[^\S\r\n]*(.+?)\s*$/gm)) {
      suggestions.push(suggestion(command, `the ${name} process in ${file}`));
    }
  }
  return { id: 'procfile', label: 'Procfile', details: [], evidence: files, notes: [], suggestions };
}

/** Targets of a task runner, filtered to the ones that start something. */
async function runnerTargets(ctx, files, pattern) {
  const file = ctx.first(files);
  if (!file) return null;
  const targets = [...((await ctx.read(file)) ?? '').matchAll(pattern)].map((match) => match[1]);
  return { file, targets: [...new Set(targets)].filter((target) => RUN_TARGETS.has(target)) };
}

async function detectTaskRunners(ctx) {
  const runners = [
    ['make', 'Make', await runnerTargets(ctx, MAKEFILES, /^([\w.-]+)[^\S\r\n]*:(?!=)/gm)],
    ['just', 'just', await runnerTargets(ctx, JUSTFILES, /^@?([\w-]+)(?:[^\S\r\n]+[^:\r\n=]*)?:(?!=)/gm)],
    ['task', 'Task', await runnerTargets(ctx, TASKFILES, /^[^\S\r\n]{2}([\w:-]+):[^\S\r\n]*$/gm)],
  ];
  return runners
    .filter(([, , found]) => found?.targets.length)
    .map(([tool, label, { file, targets }]) => ({
      id: tool,
      label,
      details: [],
      evidence: [file],
      notes: [],
      suggestions: targets.map((target) => suggestion(`${tool} ${target}`, `target declared in ${file}`)),
    }));
}

/** Every name in `COMPOSE_FILES` is one `docker compose` finds by itself, so none needs `-f`. */
async function detectCompose(ctx) {
  const file = ctx.first(COMPOSE_FILES);
  if (!file) return null;
  return {
    id: 'compose',
    label: 'Docker Compose',
    details: [],
    evidence: [file],
    notes: [],
    suggestions: [suggestion('docker compose up', `${file} declares the services`)],
  };
}

/** Only when nothing else claimed the directory: an index.html in a Node project is a build input. */
function detectStatic(ctx, found) {
  if (found.length || !ctx.present.has('index.html')) return null;
  return {
    id: 'static',
    label: 'Static site',
    details: [],
    evidence: ['index.html'],
    notes: [],
    suggestions: [
      suggestion('npx serve .', 'index.html with nothing to build it'),
      suggestion(`${platform.pythonCommand} -m http.server 8000`, 'index.html with nothing to build it'),
    ],
  };
}

const LANGUAGE_DETECTORS = [
  detectNode, detectDeno, detectPython, detectGo, detectRust, detectJvm, detectRuby, detectPhp,
  detectDotnet, detectElixir,
];

/**
 * Every stack the directory shows evidence of, each with the commands that would start it. Declared
 * runners come first — a Procfile or a `make dev` is the author saying how it starts — then the
 * languages, whose commands are inferred, then compose, which starts everything rather than this
 * one service. One detector failing is one stack missing, never an inspection that fails.
 * @param {string} dir resolved absolute directory
 * @param {string[]} names its entries, already listed by the caller
 * @param {{main: string|null, scripts: object, dependencies: Set<string>}|null} pkg its package.json
 * @param {string|null} manager the package manager that runs it
 * @returns {Promise<{id: string, label: string, details: string[], evidence: string[],
 *                    notes: string[], suggestions: {command: string, reason: string}[]}[]>}
 */
export async function detectStacks(dir, names, pkg, manager) {
  const ctx = directoryContext(dir, names, pkg, manager);
  const settle = (detector) => Promise.resolve().then(() => detector(ctx)).catch(() => null);

  const [procfile, runners, compose, ...languages] = await Promise.all(
    [detectProcfile, detectTaskRunners, detectCompose, ...LANGUAGE_DETECTORS].map(settle)
  );
  const found = [procfile, ...(runners ?? []), ...languages, compose].filter(Boolean);
  const stacks = [...found, detectStatic(ctx, found)].filter(Boolean);

  const seen = new Set();
  let remaining = MAX_SUGGESTIONS;
  return stacks.map((stack) => {
    const suggestions = stack.suggestions
      .filter(({ command }) => !seen.has(command) && seen.add(command))
      .slice(0, Math.min(MAX_SUGGESTIONS_PER_STACK, remaining));
    remaining -= suggestions.length;
    return { ...stack, suggestions };
  });
}
