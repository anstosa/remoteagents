import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService, worktreeManagementAvailability, type GitExec } from '../src/worktrees/management.js';
import { testProject } from './helpers/config.js';

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

// a Project whose worktreesDirectory is a real temp path, so the service's mkdir/access
// touch only scratch space while the git calls stay faked
async function fakeProject(over: Parameters<typeof testProject>[0] = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rac-add-')));
  dirs.push(base);
  const path = join(base, 'repo');
  await mkdir(path, { recursive: true });
  return testProject({ id: 'proj', path, worktreesDirectory: join(base, 'wts'), available: true, ...over });
}

describe('WorktreeManagementService.add — flag composition', () => {
  it('creates a new branch worktree with --no-track from the given base', async () => {
    const project = await fakeProject();
    // show-ref (branch exists) fails ⇒ the branch is free; everything else succeeds
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat/login', base: 'main' });
    expect(result).toEqual({ ok: true, path: join(project.worktreesDirectory, 'feat-login') });
    // the leaf flattens `/` to `-`; the invocation is add --no-track -b <name> <path> <base>
    expect(calls.some(args => has(args, '-C', project.path, 'worktree', 'add', '--no-track', '-b', 'feat/login', join(project.worktreesDirectory, 'feat-login'), 'main'))).toBe(true);
  });

  it('falls back to the resolved default branch when no base is given', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit(args => {
      if (has(args, 'show-ref')) return no();                                            // branch is free
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n'); // default resolves
      return undefined;
    });
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat' });
    expect(result.ok).toBe(true);
    // the omitted base resolves to the default branch and reaches worktree add as the base
    expect(calls.some(args => has(args, 'worktree', 'add', '--no-track', '-b', 'feat', join(project.worktreesDirectory, 'feat'), 'main'))).toBe(true);
  });

  it('creates an existing-branch worktree without -b', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit();
    const result = await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'existing', branch: 'release' });
    expect(result.ok).toBe(true);
    expect(calls.some(args => has(args, 'worktree', 'add', join(project.worktreesDirectory, 'release'), 'release') && !args.includes('-b'))).toBe(true);
  });
});

describe('WorktreeManagementService.add — refusals before git runs', () => {
  it('404s an unknown Project and 409s a bridge-unmounted one', async () => {
    const service = new WorktreeManagementService(() => [], fakeGit().git);
    expect(await service.add('missing', { mode: 'new', branch: 'x', base: 'main' })).toMatchObject({ ok: false, status: 404 });
    const bridged = await fakeProject({ hostPath: '/host/elsewhere' });
    const onBridge = new WorktreeManagementService(() => [bridged], fakeGit().git);
    expect(await onBridge.add('proj', { mode: 'new', branch: 'x', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('host path') });
  });

  it('rejects an invalid branch name, a traversal name, and a taken branch', async () => {
    const project = await fakeProject();
    const taken = fakeGit(args => (has(args, 'show-ref') ? ok() : undefined));
    const service = new WorktreeManagementService(() => [project], taken.git);
    expect(await service.add('proj', { mode: 'new', branch: 'bad name', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('valid branch') });
    expect(await service.add('proj', { mode: 'new', branch: '..', base: 'main' })).toMatchObject({ ok: false, status: 409 });
    expect(await service.add('proj', { mode: 'new', branch: 'exists', base: 'main' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already exists') });
  });

  it('rejects a base that does not resolve and a branch checked out elsewhere', async () => {
    const project = await fakeProject();
    const badBase = fakeGit(args => (has(args, 'show-ref') ? no() : has(args, 'rev-parse') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], badBase.git).add('proj', { mode: 'new', branch: 'feat', base: 'nope' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('does not resolve') });
    const elsewhere = fakeGit(args => (args.includes('for-each-ref') && args.includes('refs/heads/feat') ? ok('/somewhere/feat') : undefined));
    expect(await new WorktreeManagementService(() => [project], elsewhere.git).add('proj', { mode: 'existing', branch: 'feat' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already checked out') });
  });

  it('rejects a base that begins with `-` before it can be read as a git flag', async () => {
    const project = await fakeProject();
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: '--force' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('not valid') });
    // the guard fires before rev-parse or worktree add ever runs
    expect(calls.some(args => has(args, 'rev-parse') || has(args, 'worktree', 'add'))).toBe(false);
  });

  it('rejects a target path that already exists and never runs git worktree add', async () => {
    const project = await fakeProject();
    await mkdir(join(project.worktreesDirectory, 'feat'), { recursive: true });
    const { git, calls } = fakeGit(args => (has(args, 'show-ref') ? no() : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: 'main' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already exists') });
    expect(calls.some(args => has(args, 'worktree', 'add'))).toBe(false);
  });

  it('surfaces git\'s trimmed stderr when worktree add fails', async () => {
    const project = await fakeProject();
    const { git } = fakeGit(args => (has(args, 'show-ref') ? no() : has(args, 'worktree', 'add') ? no('fatal: something went wrong\n', 128) : undefined));
    expect(await new WorktreeManagementService(() => [project], git).add('proj', { mode: 'new', branch: 'feat', base: 'main' }))
      .toEqual({ ok: false, status: 409, error: 'fatal: something went wrong' });
  });
});

describe('WorktreeManagementService.branches', () => {
  it('offers local branches checked out nowhere plus remote-only branches, and the default', async () => {
    const project = await fakeProject();
    const forEach = [
      'refs/heads/main\t/repo',            // checked out here — excluded
      'refs/heads/feature\t',              // free local — offered
      'refs/remotes/origin/HEAD\t',        // symbolic — skipped
      'refs/remotes/origin/feature\t',     // has a local — not remote-only
      'refs/remotes/origin/hotfix\t'       // remote-only — offered, marked
    ].join('\n');
    const git = fakeGit(args => {
      if (has(args, 'for-each-ref') && args.includes('refs/heads')) return ok(forEach);
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return ok('origin/main\n');
      return undefined;
    }).git;
    const result = await new WorktreeManagementService(() => [project], git).branches('proj');
    expect(result).toEqual({ ok: true, defaultBranch: 'main', branches: [
      { name: 'feature', remote: false },
      { name: 'hotfix', remote: true }
    ] });
  });

  it('falls back to HEAD when origin publishes no default, and 404s an unknown Project', async () => {
    const project = await fakeProject();
    const git = fakeGit(args => {
      if (has(args, 'for-each-ref') && args.includes('refs/heads')) return ok('refs/heads/trunk\t\n');
      if (has(args, 'symbolic-ref', 'refs/remotes/origin/HEAD')) return no();
      if (has(args, 'symbolic-ref', 'HEAD')) return ok('trunk\n');
      return undefined;
    }).git;
    expect(await new WorktreeManagementService(() => [project], git).branches('proj')).toEqual({ ok: true, defaultBranch: 'trunk', branches: [{ name: 'trunk', remote: false }] });
    expect(await new WorktreeManagementService(() => [], git).branches('nope')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('worktreeManagementAvailability', () => {
  it('blocks a missing checkout and a bridge host-path mismatch, allows an identity mount', async () => {
    expect(worktreeManagementAvailability(testProject({ available: false, unavailableReason: 'path /x was not found' }))).toEqual({ available: false, reason: 'path /x was not found' });
    expect(worktreeManagementAvailability(testProject({ available: true, path: '/c/repo', hostPath: '/host/repo' })).available).toBe(false);
    expect(worktreeManagementAvailability(testProject({ available: true, path: '/repo', hostPath: '/repo' }))).toEqual({ available: true });
    expect(worktreeManagementAvailability(testProject({ available: true }))).toEqual({ available: true });
  });
});

// exercised against a real repository so the actual git invocation is proven end to end
describe('WorktreeManagementService.add — against a real repository', () => {
  const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  async function repo() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-add-real-')));
    dirs.push(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'readme.md'), 'hi\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'initial');
    return root;
  }

  it('creates a worktree for a new branch and for an existing branch', async () => {
    const root = await repo();
    const worktreesDirectory = `${root}-wts`;
    dirs.push(worktreesDirectory);
    const project = testProject({ id: 'proj', path: root, identity: join(root, '.git'), worktreesDirectory, available: true });
    const service = new WorktreeManagementService(() => [project]);

    const created = await service.add('proj', { mode: 'new', branch: 'feature/one', base: 'main' });
    expect(created).toEqual({ ok: true, path: await realpath(join(worktreesDirectory, 'feature-one')) });
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/feature/one');

    await git(root, 'branch', 'existing', 'main');
    const adopted = await service.add('proj', { mode: 'existing', branch: 'existing' });
    expect(adopted).toEqual({ ok: true, path: await realpath(join(worktreesDirectory, 'existing')) });

    // a base that does not resolve is refused with git untouched
    expect(await service.add('proj', { mode: 'new', branch: 'feature/two', base: 'no-such-ref' })).toMatchObject({ ok: false, status: 409 });
  });
});
