/**
 * Source control, read-only: is a service's directory a git repository, what is changed in it, what
 * a change looks like, and the history behind it — the Source Control view of an editor, for the
 * repositories Paddock runs.
 *
 * It asks the `git` binary rather than reading `.git` itself. A library re-implementation lags the
 * repository formats git itself writes and misreads worktrees and submodules; the binary the
 * developer already uses is, by definition, right about their repository. Only machine formats are
 * read (`--porcelain=v2 -z`, `-z` log records), so a path with spaces, quotes or newlines parses the
 * same as any other, and the parsers are pure functions over that output — testable without git.
 *
 * Nothing here writes. Staging, committing and discarding change the user's repository and are not
 * this module's to do. Every call also sets GIT_OPTIONAL_LOCKS=0: a status poll that refreshed the
 * index would take `index.lock` and could fail the developer's own `git commit` running beside it.
 */
import { execFile } from 'child_process';
import path from 'path';

/** A status or log that takes longer than this is a repository being rewritten, not one to wait on. */
const GIT_TIMEOUT_MS = 5_000;
/** A diff larger than this is not read in a side panel; the rest is cut and said to be cut. */
export const DIFF_LIMIT_BYTES = 512 * 1024;
/** Read past the limit so that "cut" is known rather than guessed, but not without bound. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1_000;

/** Unit and record separators: a commit subject can hold anything but these. */
const FIELD = '\x1f';
const LOG_FORMAT = ['%H', '%P', '%D', '%an', '%aI', '%s'].join('%x1f');

/** A git failure the caller can act on, keyed so the dashboard can say what to do about it. */
export class GitError extends Error {
  /** @param {'git_missing'|'timeout'|'not_a_repo'|'invalid_path'|'git_failed'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- parsers ---------------------------------------------------------------------------------

/**
 * The staged and unstaged halves of a porcelain `XY`. `.` is "unchanged on this side".
 * @param {string} xy
 */
const sidesOf = (xy) => ({ staged: xy[0] === '.' ? null : xy[0], unstaged: xy[1] === '.' ? null : xy[1] });

/**
 * One entry per side that changed: a file edited, staged, then edited again is in both lists, as
 * the editor shows it.
 * @param {object} result @param {string} xy @param {string} file @param {string} [origPath]
 */
function addChange(result, xy, file, origPath) {
  const { staged, unstaged } = sidesOf(xy);
  const entry = (status) => (origPath ? { path: file, origPath, status } : { path: file, status });
  if (staged) result.staged.push(entry(staged));
  if (unstaged) result.unstaged.push(entry(unstaged));
}

/** @param {object} result @param {string} header the text after `# ` */
function applyHeader(result, header) {
  const [key, ...rest] = header.split(' ');
  const value = rest.join(' ');
  if (key === 'branch.head') {
    result.detached = value === '(detached)';
    result.branch = result.detached ? null : value;
  } else if (key === 'branch.upstream') {
    result.upstream = value;
  } else if (key === 'branch.ab') {
    const [, ahead, behind] = value.match(/^\+(\d+) -(\d+)$/) ?? [];
    result.ahead = Number(ahead ?? 0);
    result.behind = Number(behind ?? 0);
  }
}

/**
 * `git status --porcelain=v2 --branch -z`, as data.
 * @param {string} output
 */
export function parseStatus(output) {
  const result = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const kind = record[0];
    if (kind === '#') {
      applyHeader(result, record.slice(2));
    } else if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path — the path is everything after the eighth field.
      const fields = record.split(' ');
      addChange(result, fields[1], fields.slice(8).join(' '));
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record.
      const fields = record.split(' ');
      addChange(result, fields[1], fields.slice(9).join(' '), records[++i]);
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      result.conflicted.push({ path: record.split(' ').slice(10).join(' ') });
    } else if (kind === '?') {
      result.untracked.push({ path: record.slice(2) });
    }
  }
  return result;
}

/**
 * `git log -z --format=<LOG_FORMAT>`, as data. `refs` keeps git's own decoration names
 * (`HEAD -> main`, `origin/main`, `tag: v1.0.0`), which is what a graph labels its commits with.
 * @param {string} output
 */
export function parseLog(output) {
  return output
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, refs, author, at, ...subject] = record.split(FIELD);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ') : [],
        author,
        at,
        subject: subject.join(FIELD),
      };
    });
}

// --- running git -----------------------------------------------------------------------------

/**
 * @param {string} cwd @param {string[]} args
 * @param {{okCodes?: number[]}} [options] exit codes that still mean success — `diff --no-index`
 *   exits 1 whenever the files differ, which for an untracked file is always.
 * @returns {Promise<{stdout: string, truncated: boolean}>}
 */
function runGit(cwd, args, { okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (!err || okCodes.includes(err.code)) return resolve({ stdout, truncated: false });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout, truncated: true });
        reject(toGitError(err, stderr));
      }
    );
  });
}

/** @param {NodeJS.ErrnoException & {killed?: boolean}} err @param {string} stderr */
function toGitError(err, stderr) {
  if (err.code === 'ENOENT') return new GitError('git_missing', 'git is not installed or not on PATH.');
  if (err.killed) return new GitError('timeout', `git did not answer within ${GIT_TIMEOUT_MS / 1000}s.`);
  if (/not a git repository/i.test(stderr)) return new GitError('not_a_repo', 'Not a git repository.');
  return new GitError('git_failed', stderr.trim() || err.message);
}

/**
 * The repository `dir` is inside, or null. A service's path is often a package inside a monorepo,
 * so the repository root is looked up rather than assumed to be `dir`.
 * @param {string} dir
 */
async function repositoryRoot(dir) {
  try {
    const { stdout } = await runGit(dir, ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch (err) {
    if (err.code === 'not_a_repo') return null;
    throw err;
  }
}

/**
 * A path the dashboard asks about must be one of this repository's files, never a way out of it.
 * @param {string} root @param {string} file repository-relative, as status reported it
 */
function insideRoot(root, file) {
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (!file || path.isAbsolute(file) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new GitError('invalid_path', `${file} is not a path inside this repository.`);
  }
  return relative.split(path.sep).join('/');
}

// --- the three questions ---------------------------------------------------------------------

/**
 * @param {string} dir the service's directory
 * @returns {Promise<{repo: false} | ({repo: true, root: string} & ReturnType<typeof parseStatus>)>}
 */
export async function status(dir) {
  const root = await repositoryRoot(dir);
  if (!root) return { repo: false };
  const { stdout } = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z']);
  return { repo: true, root, ...parseStatus(stdout) };
}

/**
 * One file's change. An untracked file has no diff in git's sense, so it is shown as all-added.
 * @param {string} dir @param {{path: string, staged?: boolean, untracked?: boolean}} options
 * @returns {Promise<{diff: string, truncated: boolean, binary: boolean}>}
 */
export async function diff(dir, { path: file, staged = false, untracked = false }) {
  const root = await repositoryRoot(dir);
  if (!root) throw new GitError('not_a_repo', 'Not a git repository.');
  const relative = insideRoot(root, file);
  const args = untracked
    ? ['diff', '--no-index', '--no-color', '--', '/dev/null', relative]
    : ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', relative];
  const { stdout, truncated } = await runGit(root, args, { okCodes: untracked ? [0, 1] : [0] });
  const cut = truncated || Buffer.byteLength(stdout) > DIFF_LIMIT_BYTES;
  return {
    diff: cut ? Buffer.from(stdout).subarray(0, DIFF_LIMIT_BYTES).toString() : stdout,
    truncated: cut,
    binary: /^Binary files .* differ$/m.test(stdout),
  };
}

/**
 * Recent history across the local and remote branches, newest first in topological order — the
 * order a graph can lay out lanes from, using each commit's `parents`.
 * @param {string} dir @param {{limit?: number}} [options]
 */
export async function log(dir, { limit = DEFAULT_LOG_LIMIT } = {}) {
  const root = await repositoryRoot(dir);
  if (!root) throw new GitError('not_a_repo', 'Not a git repository.');
  const count = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
  try {
    const { stdout } = await runGit(root, [
      'log',
      '-z',
      '--topo-order',
      `--max-count=${count}`,
      `--format=${LOG_FORMAT}`,
      'HEAD',
      '--branches',
      '--remotes',
    ]);
    return { commits: parseLog(stdout) };
  } catch (err) {
    // A repository with no commits yet has nothing for HEAD to name; that is an empty history.
    if (err.code === 'git_failed' && /does not have any commits|unknown revision/i.test(err.message)) {
      return { commits: [] };
    }
    throw err;
  }
}
