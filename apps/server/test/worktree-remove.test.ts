import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService, type GitExec } from '../src/worktrees/management.js';
import { testProject, testWorktree } from './helpers/config.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type GitResult = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const no = (stderr = '', code = 1): GitResult => ({ code, stdout: '', stderr });

// a recording git fake: `handler` answers specific argv shapes; anything else succeeds
function fakeGit(handler: (args: string[]) => GitResult | undefined = () => undefined): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async args => { calls.push(args); return handler(args) ?? ok(); };
  return { git, calls };
}
const has = (args: string[], ...needles: string[]) => needles.every(needle => args.includes(needle));

const project = testProject({ id: 'proj', path: '/repo' });
const linked = testWorktree({ id: 'proj:/repo/wts/feat', projectId: 'proj', path: '/repo/wts/feat', identity: '/repo/wts/feat', main: false, branch: 'feat', pinned: false });

describe('WorktreeManagementService.removal — fresh facts', () => {
  it('reports dirty count, pushed, merged, and ahead/behind', async () => {
    const { git } = fakeGit(args => {
      if (has(args, 'status', '--porcelain')) return ok(' M a.txt\n?? b.txt\n');            // 2 changed paths, untracked counts
      if (has(args, 'branch', '-r', '--contains', 'HEAD')) return ok('  origin/feat\n');     // HEAD is on the remote
      if (has(args, 'merge-base', '--is-ancestor')) return ok();                             // merged into the default
      if (has(args, 'rev-list', '--left-right', '--count')) return ok('1\t3\n');             // 1 ahead, 3 behind
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n');
      return undefined;
    });
    const result = await new WorktreeManagementService(() => [project], git).removal(linked);
    expect(result).toEqual({ ok: true, facts: { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 2, pushed: true, merged: true, ahead: 1, behind: 3 } });
  });

  it('treats a `[gone]` upstream as pushed and omits ahead/behind without one', async () => {
    const { git } = fakeGit(args => {
      if (has(args, 'status', '--porcelain')) return ok('');                                  // clean
      if (has(args, 'branch', '-r', '--contains', 'HEAD')) return ok('');                     // not contained anywhere
      if (has(args, 'for-each-ref', 'refs/heads/feat')) return ok('[gone]\n');                // upstream deleted on the remote
      if (has(args, 'merge-base', '--is-ancestor')) return no('', 1);                          // not merged
      if (has(args, 'rev-list', '--left-right', '--count')) return no();                       // no upstream to compare
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n');
      return undefined;
    });
    const result = await new WorktreeManagementService(() => [project], git).removal(linked);
    expect(result).toMatchObject({ ok: true, facts: { dirtyCount: 0, pushed: true, merged: false } });
    expect((result as { facts: { ahead?: number } }).facts.ahead).toBeUndefined();
  });

  it('reports merged via the local default branch when origin/<default> lacks HEAD', async () => {
    const { git } = fakeGit(args => {
      if (has(args, 'branch', '-r', '--contains', 'HEAD')) return ok('');                          // not on any remote
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n');
      if (has(args, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main')) return no('', 1);        // not on remote main…
      if (has(args, 'merge-base', '--is-ancestor', 'HEAD', 'main')) return ok();                    // …but merged into local main
      return undefined;
    });
    // early-returning false on the origin ref would report `merged: false`; both refs are checked
    expect(await new WorktreeManagementService(() => [project], git).removal(linked)).toMatchObject({ ok: true, facts: { merged: true } });
  });

  it('reports the lock and its reason from the discovered record for a locked worktree', async () => {
    const locked = testWorktree({ ...linked, locked: true, lockedReason: 'being edited by the operator' });
    const result = await new WorktreeManagementService(() => [project], fakeGit().git).removal(locked);
    expect(result).toMatchObject({ ok: true, facts: { locked: true, lockedReason: 'being edited by the operator' } });
  });

  it('omits the branch for a detached worktree', async () => {
    const detached = testWorktree({ id: 'proj:/repo/wts/x', projectId: 'proj', path: '/repo/wts/x', identity: '/repo/wts/x', main: false, detached: true, sha: 'abcdef1', pinned: false });
    const result = await new WorktreeManagementService(() => [project], fakeGit().git).removal(detached);
    expect(result).toMatchObject({ ok: true, facts: { detached: true } });
    expect((result as { facts: { branch?: string } }).facts.branch).toBeUndefined();
  });

  it('404s an unknown Project and 409s a bridge-unmounted one', async () => {
    expect(await new WorktreeManagementService(() => [], fakeGit().git).removal(linked)).toMatchObject({ ok: false, status: 404 });
    const bridged = testProject({ id: 'proj', path: '/c/repo', hostPath: '/host/repo' });
    expect(await new WorktreeManagementService(() => [bridged], fakeGit().git).removal(linked)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('host path') });
  });
});

describe('WorktreeManagementService.removeCheckout — flags and refusals', () => {
  it('removes without --force by default', async () => {
    const { git, calls } = fakeGit();
    expect(await new WorktreeManagementService(() => [project], git).removeCheckout(linked, { force: false })).toEqual({ ok: true });
    expect(calls.some(args => has(args, '-C', '/repo', 'worktree', 'remove', '/repo/wts/feat') && !args.includes('--force'))).toBe(true);
  });

  it('adds --force exactly once when discarding, never `-f -f`', async () => {
    const { git, calls } = fakeGit();
    await new WorktreeManagementService(() => [project], git).removeCheckout(linked, { force: true });
    const removeCall = calls.find(args => has(args, 'worktree', 'remove'))!;
    expect(removeCall.filter(arg => arg === '--force')).toEqual(['--force']);
    expect(removeCall).not.toContain('-f');
  });

  it('refuses the main worktree and a locked one before git runs', async () => {
    const { git, calls } = fakeGit();
    const service = new WorktreeManagementService(() => [project], git);
    expect(await service.removeCheckout(testWorktree({ projectId: 'proj', main: true }), { force: false })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('main worktree') });
    expect(await service.removeCheckout(testWorktree({ ...linked, locked: true }), { force: false })).toMatchObject({ ok: false, status: 409, error: 'Locked worktrees cannot be removed' });
    expect(calls.some(args => has(args, 'worktree', 'remove'))).toBe(false);
  });

  it('surfaces git\'s trimmed stderr on failure', async () => {
    const { git } = fakeGit(args => (has(args, 'worktree', 'remove') ? no('fatal: contains modified or untracked files\n', 128) : undefined));
    expect(await new WorktreeManagementService(() => [project], git).removeCheckout(linked, { force: false }))
      .toEqual({ ok: false, status: 409, error: 'fatal: contains modified or untracked files' });
  });
});

describe('WorktreeManagementService.deleteBranch', () => {
  it('runs the forced delete and reports git\'s failure', async () => {
    const okGit = fakeGit();
    expect(await new WorktreeManagementService(() => [project], okGit.git).deleteBranch(linked, 'feat')).toEqual({ ok: true });
    expect(okGit.calls.some(args => has(args, '-C', '/repo', 'branch', '-D', 'feat'))).toBe(true);
    const failGit = fakeGit(args => (has(args, 'branch', '-D') ? no('error: branch not found\n') : undefined));
    expect(await new WorktreeManagementService(() => [project], failGit.git).deleteBranch(linked, 'feat')).toEqual({ ok: false, error: 'error: branch not found' });
  });

  it('rejects a flag-shaped branch name before git runs', async () => {
    const { git, calls } = fakeGit();
    expect(await new WorktreeManagementService(() => [project], git).deleteBranch(linked, '--all')).toMatchObject({ ok: false });
    expect(calls.some(args => has(args, 'branch', '-D'))).toBe(false);
  });
});

describe('WorktreeManagementService.prune', () => {
  it('runs git worktree prune and surfaces its failure', async () => {
    const okGit = fakeGit();
    expect(await new WorktreeManagementService(() => [project], okGit.git).prune('proj')).toEqual({ ok: true });
    expect(okGit.calls.some(args => has(args, '-C', '/repo', 'worktree', 'prune'))).toBe(true);
    expect(await new WorktreeManagementService(() => [], okGit.git).prune('missing')).toMatchObject({ ok: false, status: 404 });
    const failGit = fakeGit(args => (has(args, 'worktree', 'prune') ? no('fatal: nope\n', 128) : undefined));
    expect(await new WorktreeManagementService(() => [project], failGit.git).prune('proj')).toEqual({ ok: false, status: 409, error: 'fatal: nope' });
  });
});

// exercised against a real repository so the git invocations are proven end to end
describe('Worktree add → remove → prune against a real repository', () => {
  const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  async function repo() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-remove-real-')));
    dirs.push(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'readme.md'), 'hi\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'initial');
    return root;
  }

  it('removes a clean checkout, a dirty one with discard, deletes a merged branch, then prunes', async () => {
    const root = await repo();
    const worktreesDirectory = `${root}-wts`;
    dirs.push(worktreesDirectory);
    const project = testProject({ id: 'proj', path: root, identity: join(root, '.git'), worktreesDirectory, available: true });
    const service = new WorktreeManagementService(() => [project]);
    const discovered = async (branch: string) => {
      const path = await realpath(join(worktreesDirectory, branch.replaceAll('/', '-')));
      return testWorktree({ id: `proj:${path}`, projectId: 'proj', path, identity: path, main: false, branch });
    };

    // a clean new-branch checkout removes without force
    await service.add('proj', { mode: 'new', branch: 'clean', base: 'main' });
    const clean = await discovered('clean');
    const cleanFacts = await service.removal(clean);
    expect(cleanFacts).toMatchObject({ ok: true, facts: { dirtyCount: 0, merged: true } }); // branched off main, so HEAD is an ancestor of main
    expect(await service.removeCheckout(clean, { force: false })).toEqual({ ok: true });
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('clean');

    // a dirty checkout reports the count and needs --force
    await service.add('proj', { mode: 'new', branch: 'dirty', base: 'main' });
    const dirty = await discovered('dirty');
    await writeFile(join(dirty.path, 'scratch.txt'), 'wip\n');
    expect((await service.removal(dirty) as { facts: { dirtyCount: number } }).facts.dirtyCount).toBe(1);
    expect(await service.removeCheckout(dirty, { force: false })).toMatchObject({ ok: false, status: 409 });
    expect(await service.removeCheckout(dirty, { force: true })).toEqual({ ok: true });

    // a merged branch can be force-deleted after removal
    await service.add('proj', { mode: 'new', branch: 'merged', base: 'main' });
    const merged = await discovered('merged');
    expect(await service.removeCheckout(merged, { force: false })).toEqual({ ok: true });
    expect(await service.deleteBranch(merged, 'merged')).toEqual({ ok: true });
    await expect(git(root, 'rev-parse', '--verify', 'refs/heads/merged')).rejects.toThrow();

    // prune clears a checkout whose directory vanished out from under git
    await service.add('proj', { mode: 'new', branch: 'gone', base: 'main' });
    const gone = await realpath(join(worktreesDirectory, 'gone'));
    await rm(gone, { recursive: true, force: true });
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain('prunable');
    expect(await service.prune('proj')).toEqual({ ok: true });
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('gone');
  });

  it('reports a branch whose remote was deleted (a [gone] upstream) as pushed', async () => {
    const remote = await realpath(await mkdtemp(join(tmpdir(), 'rac-remove-remote-')));
    dirs.push(remote);
    await git(remote, 'init', '-q', '-b', 'main');
    await git(remote, 'config', 'user.email', 'test@example.com');
    await git(remote, 'config', 'user.name', 'Test');
    await writeFile(join(remote, 'readme.md'), 'hi\n');
    await git(remote, 'add', '.');
    await git(remote, 'commit', '-q', '-m', 'initial');

    const parent = await realpath(await mkdtemp(join(tmpdir(), 'rac-remove-gone-')));
    dirs.push(parent);
    const checkout = join(parent, 'work');
    await git(parent, 'clone', '-q', remote, checkout);
    await git(checkout, 'config', 'user.email', 'test@example.com');
    await git(checkout, 'config', 'user.name', 'Test');
    const worktreesDirectory = `${checkout}-wts`;
    dirs.push(worktreesDirectory);
    const project = testProject({ id: 'proj', path: checkout, identity: join(checkout, '.git'), worktreesDirectory, available: true });
    const service = new WorktreeManagementService(() => [project]);

    // branch feat off main, commit a unique change, push it (setting the upstream)…
    await service.add('proj', { mode: 'new', branch: 'feat', base: 'main' });
    const path = await realpath(join(worktreesDirectory, 'feat'));
    await writeFile(join(path, 'feature.txt'), 'work\n');
    await git(path, 'add', '.');
    await git(path, 'commit', '-q', '-m', 'feature work');
    await git(path, 'push', '-q', '-u', 'origin', 'feat');
    // …then delete it on the remote and prune, leaving the upstream `[gone]`
    await git(remote, 'branch', '-D', 'feat');
    await git(checkout, 'fetch', '-q', '--prune');

    const worktree = testWorktree({ id: `proj:${path}`, projectId: 'proj', path, identity: path, main: false, branch: 'feat' });
    // the unique commit is on no origin ref, so `[gone]` is the only signal it was ever pushed
    expect(await service.removal(worktree)).toMatchObject({ ok: true, facts: { pushed: true, dirtyCount: 0 } });
  });
});
