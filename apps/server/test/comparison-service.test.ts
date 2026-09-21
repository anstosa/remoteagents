import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ComparisonService, type PreferredBaseResolver } from '../src/git/comparison-service.js';
import type { Worktree } from '../src/domain/models.js';

const execute = promisify(execFile);
const roots: string[] = [];

// run one fixture Git command, returning its stdout
async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('/usr/bin/git', ['-C', root, ...args]);
  return stdout;
}

// initialise an empty repository on `main`
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-comparison-service-'));
  roots.push(root);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'compare@example.com');
  await git(root, 'config', 'user.name', 'Compare Fixture');
  return root;
}

// a worktree record pointing the service at one fixture repo
function worktree(root: string, overrides: Partial<Worktree> = {}): Worktree {
  return { id: 'w1', projectId: 'p1', label: 'Fixture', path: root, identity: root, available: true, pinned: false, main: true, detached: false, locked: false, branch: 'feature', ...overrides };
}

// the base resolver: `main` for an All PR fixture, or none (the full ladder finds nothing without a remote)
const noBase: PreferredBaseResolver = async () => undefined;
const baseMain: PreferredBaseResolver = async () => 'main';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// build a repo with a `main` base commit and a `feature` checkout that modifies, renames, deletes,
// adds, and leaves one file untracked — the standard fixture the Comparison reads
async function featureRepo(): Promise<string> {
  const root = await repo();
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'src', 'a.ts'), 'v1\n'),
    writeFile(join(root, 'gone.ts'), 'bye\n'),
    writeFile(join(root, 'old.ts'), 'line1\nline2\nline3\nline4\n')
  ]);
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  await git(root, 'switch', '-c', 'feature');
  await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\n');
  await git(root, 'mv', 'old.ts', 'renamed.ts');
  await writeFile(join(root, 'renamed.ts'), 'line1\nline2\nline3\nline4\nline5\n');
  await git(root, 'rm', 'gone.ts');
  await writeFile(join(root, 'added.ts'), 'brand new\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'feature');
  // uncommitted working-tree edits on top of the feature commit
  await writeFile(join(root, 'src', 'a.ts'), 'v1\nv2\nv3\n');
  await writeFile(join(root, 'note.txt'), 'a note\n');
  return root;
}

describe('ComparisonService patch', () => {
  it('captures the Working Comparison with a fingerprint and per-file patches', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    const result = await service.patch(worktree(root), 'working');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('working');
    expect(result.patch.base).toBe('HEAD');
    expect(result.patch.fingerprint).toMatch(/^[\w-]+$/u);
    const paths = result.patch.files.map(file => file.change.path).sort();
    expect(paths).toEqual(['note.txt', 'src/a.ts']);
    const modified = result.patch.files.find(file => file.change.path === 'src/a.ts');
    expect(modified?.patch).toContain('+v3');
    const untracked = result.patch.files.find(file => file.change.path === 'note.txt');
    expect(untracked?.kind).toBe('untracked');
    expect(untracked?.patch).toContain('+a note');
  });

  it('compares against the resolved base for an All PR Comparison', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const result = await service.patch(worktree(root), 'pr');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.base).toBe('main');
    const paths = result.patch.files.map(file => file.change.path).sort();
    // the PR Comparison spans the whole feature branch plus the untracked working-tree file
    expect(paths).toEqual(['added.ts', 'gone.ts', 'note.txt', 'renamed.ts', 'src/a.ts']);
  });

  it('reports a failure reason when no base resolves for an All PR Comparison', async () => {
    const root = await featureRepo();
    // no resolved base and no origin remote — the full ladder finds nothing
    const service = new ComparisonService(noBase);
    const result = await service.patch(worktree(root, { branch: 'feature' }), 'pr');
    expect(result).toEqual({ ok: false, reason: 'no_base' });
  });

  it('marks a file past the per-file cap as capped without its patch', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await writeFile(join(root, 'big.txt'), `${'x'.repeat(5_000)}\n`);
    const service = new ComparisonService(noBase, { perFileBytes: 100, totalBytes: 1_000, maxFiles: 10 });
    const result = await service.patch(worktree(root), 'working');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const big = result.patch.files.find(file => file.change.path === 'big.txt');
    expect(big?.capped).toBe(true);
    expect(big?.patch).toBe('');
  });

  it('moves the fingerprint when a size-capped untracked file is edited in place (F2)', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    // an untracked file whose patch is withheld by the per-file cap
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(400));
    const service = new ComparisonService(noBase, { perFileBytes: 100, totalBytes: 10_000, maxFiles: 10 });
    const before = await service.patch(worktree(root), 'working');
    // append lines to the capped untracked file
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(600));
    const after = await service.patch(worktree(root), 'working');
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // the withheld file stays capped across both captures, but its enriched line count moves the fingerprint
    expect(before.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.fingerprint).not.toBe(before.patch.fingerprint);
  });

  it('moves the All PR fingerprint when a size-capped untracked file is edited in place', async () => {
    const root = await repo();
    await writeFile(join(root, 'seed.txt'), 'seed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(400));
    const service = new ComparisonService(baseMain, { perFileBytes: 100, totalBytes: 10_000, maxFiles: 10 });
    const before = await service.patch(worktree(root), 'pr');
    await writeFile(join(root, 'huge.txt'), 'line\n'.repeat(600));
    const after = await service.patch(worktree(root), 'pr');
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // untracked entries are copied into an All PR Comparison, yet the enrichment still moves the fingerprint
    expect(before.patch.files.find(file => file.change.path === 'huge.txt')?.capped).toBe(true);
    expect(after.patch.fingerprint).not.toBe(before.patch.fingerprint);
  });
});

describe('ComparisonService file', () => {
  it('returns a modified file at the base and the working tree', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    const result = await service.file(worktree(root), 'working', 'src/a.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base?.content).toBe('v1\nv2\n');
    expect(result.working?.content).toBe('v1\nv2\nv3\n');
  });

  it('reads a rename origin at the base and the new path at the working tree', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const result = await service.file(worktree(root), 'pr', 'renamed.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the base holds the pre-rename contents (from old.ts); the working tree holds the renamed file
    expect(result.base?.content).toBe('line1\nline2\nline3\nline4\n');
    expect(result.working?.content).toBe('line1\nline2\nline3\nline4\nline5\n');
  });

  it('omits the base for an added file and the working side for a deleted file', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(baseMain);
    const added = await service.file(worktree(root), 'pr', 'added.ts');
    expect(added.ok).toBe(true);
    if (added.ok) { expect(added.base).toBeUndefined(); expect(added.working?.content).toBe('brand new\n'); }
    const deleted = await service.file(worktree(root), 'pr', 'gone.ts');
    expect(deleted.ok).toBe(true);
    if (deleted.ok) { expect(deleted.base?.content).toBe('bye\n'); expect(deleted.working).toBeUndefined(); }
  });

  it('serves a new file at a rename origin path, not the renamed file, when both exist', async () => {
    const root = await repo();
    await writeFile(join(root, 'old.ts'), 'the original\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'base');
    await git(root, 'switch', '-c', 'feature');
    // rename old.ts -> new.ts, then create a brand-new untracked file back at old.ts
    await git(root, 'mv', 'old.ts', 'new.ts');
    await git(root, 'commit', '-am', 'rename');
    await writeFile(join(root, 'old.ts'), 'a different new file\n');
    const service = new ComparisonService(baseMain);
    const result = await service.file(worktree(root), 'pr', 'old.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the exact path match wins: `old.ts` now names the new untracked file, not the rename origin
    expect(result.working?.content).toBe('a different new file\n');
  });

  it('refuses a path that is not a Change in the Comparison', async () => {
    const root = await featureRepo();
    const service = new ComparisonService(noBase);
    // src/a.ts and note.txt are the only Working Changes; unchanged.ts is not, even though it exists
    await writeFile(join(root, 'src', 'unchanged.ts'), 'committed\n');
    await git(root, 'add', 'src/unchanged.ts');
    await git(root, 'commit', '-m', 'add unchanged');
    const result = await service.file(worktree(root), 'working', 'src/unchanged.ts');
    expect(result).toEqual({ ok: false, reason: 'not_in_comparison' });
  });
});
