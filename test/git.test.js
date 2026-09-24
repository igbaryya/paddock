/**
 * git.js — the porcelain parsers against fabricated output, then the three questions against a real
 * repository made in a temp directory.
 *
 * The fabricated cases are the ones that are fiddly to arrange for real and easy to parse wrongly: a
 * rename (whose original path arrives as the next record), a path with spaces, a conflict, a detached
 * HEAD, a branch with no upstream. The live half catches what fixtures cannot: that the flags still
 * produce the format the parsers expect.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = await import(new URL('../git.js', import.meta.url).href);

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const z = (...records) => `${records.join('\0')}\0`;

describe('parseStatus', () => {
  test('reads the branch, its upstream and how far apart they are', () => {
    const status = git.parseStatus(
      z('# branch.oid 1234', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1')
    );
    assert.equal(status.branch, 'main');
    assert.equal(status.detached, false);
    assert.equal(status.upstream, 'origin/main');
    assert.equal(status.ahead, 2);
    assert.equal(status.behind, 1);
  });

  test('a detached HEAD has no branch, and no upstream means zero apart', () => {
    const status = git.parseStatus(z('# branch.oid 1234', '# branch.head (detached)'));
    assert.equal(status.branch, null);
    assert.equal(status.detached, true);
    assert.equal(status.upstream, null);
    assert.deepEqual([status.ahead, status.behind], [0, 0]);
  });

  test('a file changed on both sides is listed in both', () => {
    const status = git.parseStatus(z('1 MM N... 100644 100644 100644 aaa bbb src/app.js'));
    assert.deepEqual(status.staged, [{ path: 'src/app.js', status: 'M' }]);
    assert.deepEqual(status.unstaged, [{ path: 'src/app.js', status: 'M' }]);
  });

  test('keeps spaces in a path', () => {
    const status = git.parseStatus(z('1 .M N... 100644 100644 100644 aaa bbb docs/read me.md'));
    assert.deepEqual(status.unstaged, [{ path: 'docs/read me.md', status: 'M' }]);
    assert.deepEqual(status.staged, []);
  });

  test('a rename carries its original path, which arrives as the next record', () => {
    const status = git.parseStatus(
      z('2 R. N... 100644 100644 100644 aaa bbb R100 new name.js', 'old name.js', '? after.txt')
    );
    assert.deepEqual(status.staged, [{ path: 'new name.js', origPath: 'old name.js', status: 'R' }]);
    assert.deepEqual(status.untracked, [{ path: 'after.txt' }]);
  });

  test('conflicts and untracked files are their own groups', () => {
    const status = git.parseStatus(
      z('u UU N... 100644 100644 100644 100644 aaa bbb ccc both.js', '? new.txt')
    );
    assert.deepEqual(status.conflicted, [{ path: 'both.js' }]);
    assert.deepEqual(status.untracked, [{ path: 'new.txt' }]);
    assert.deepEqual([status.staged, status.unstaged], [[], []]);
  });
});

describe('parseLog', () => {
  test('reads parents, refs and a subject that contains the field separator', () => {
    const F = '\x1f';
    const commits = git.parseLog(
      z(
        ['c2', 'c1 m1', 'HEAD -> main, origin/main', 'Ada', '2026-09-01T10:00:00+00:00', `odd${F}subject`].join(F),
        ['c1', '', '', 'Ada', '2026-08-01T10:00:00+00:00', 'root'].join(F)
      )
    );
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].parents, ['c1', 'm1']);
    assert.deepEqual(commits[0].refs, ['HEAD -> main', 'origin/main']);
    assert.equal(commits[0].subject, `odd${F}subject`);
    assert.deepEqual(commits[1].parents, []);
    assert.deepEqual(commits[1].refs, []);
  });
});

describe('against a real repository', { skip: !hasGit && 'git is not installed' }, () => {
  let repo;
  let outside;
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-git-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-nogit-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('a directory outside any repository is not a repository', async () => {
    assert.deepEqual(await git.status(outside), { repo: false });
  });

  test('a repository with no commits has an empty history, not an error', async () => {
    assert.deepEqual(await git.log(repo), { commits: [] });
  });

  test('status, diff and log agree with what was done to the repository', async () => {
    fs.mkdirSync(path.join(repo, 'pkg'));
    fs.writeFileSync(path.join(repo, 'pkg', 'a.txt'), 'one\n');
    run('add', '.');
    run('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'pkg', 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'fresh\n');

    // Asked from a package inside the repository, as a service's path usually is.
    const status = await git.status(path.join(repo, 'pkg'));
    assert.equal(status.repo, true);
    assert.equal(fs.realpathSync(status.root), fs.realpathSync(repo));
    assert.equal(status.branch, 'main');
    assert.deepEqual(status.unstaged, [{ path: 'pkg/a.txt', status: 'M' }]);
    assert.deepEqual(status.untracked, [{ path: 'new file.txt' }]);

    const change = await git.diff(repo, { path: 'pkg/a.txt' });
    assert.match(change.diff, /^-one$/m);
    assert.match(change.diff, /^\+two$/m);
    assert.equal(change.truncated, false);

    const added = await git.diff(repo, { path: 'new file.txt', untracked: true });
    assert.match(added.diff, /^\+fresh$/m);

    const { commits } = await git.log(repo);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, 'first');
    assert.ok(commits[0].refs.some((ref) => ref.includes('main')));
  });

  test('refuses a path that leaves the repository', async () => {
    await assert.rejects(git.diff(repo, { path: '../etc/passwd' }), { code: 'invalid_path' });
    await assert.rejects(git.diff(repo, { path: '/etc/passwd' }), { code: 'invalid_path' });
  });
});
