import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { WorktreeManagementService } from '../src/worktrees/management.js';
import { testProject } from './helpers/config.js';

const directories: string[] = [];
// remove every temporary repository
afterEach(async () => {
  // clear all registered paths
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// run one repository command
const git = async (path: string, ...args: string[]) => {
  const result = await run('/usr/bin/git', ['-C', path, ...args]);
  // surface command failures
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

// create one managed repository
async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-branches-')));
  directories.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'readme.md'), 'initial\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'initial');
  const project = testProject({ id: 'proj', label: 'Project', path: root, identity: join(root, '.git'), worktreesDirectory: `${root}-worktrees`, available: true });
  directories.push(project.worktreesDirectory);
  return { root, service: new WorktreeManagementService(() => [project]) };
}

describe('guarded branch deletion', () => {
  it('lists merged branches for cleanup and protects unpushed work behind acknowledgement', async () => {
    const { root, service } = await repository();
    await git(root, 'checkout', '-q', '-b', 'merged');
    await writeFile(join(root, 'merged.txt'), 'merged\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'merged work');
    await git(root, 'checkout', '-q', 'main');
    await git(root, 'merge', '-q', '--no-ff', 'merged', '-m', 'merge feature');
    await git(root, 'checkout', '-q', '-b', 'risky');
    await writeFile(join(root, 'risky.txt'), 'risky\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'risky work');
    await git(root, 'checkout', '-q', 'main');

    await expect(service.mergedBranches()).resolves.toEqual([{ projectId: 'proj', projectLabel: 'Project', branch: 'merged' }]);
    await expect(service.branchRemoval('proj', 'merged')).resolves.toEqual({ ok: true, facts: { branch: 'merged', checkedOut: false, dirtyCount: 0, pushed: false, merged: true, defaultBranch: false } });
    await expect(service.deleteMergedBranch('proj', 'merged')).resolves.toBe(true);
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/merged')).rejects.toThrow();

    await expect(service.branchRemoval('proj', 'risky')).resolves.toEqual({ ok: true, facts: { branch: 'risky', checkedOut: false, dirtyCount: 0, pushed: false, merged: false, defaultBranch: false } });
    await expect(service.deleteMergedBranch('proj', 'risky')).resolves.toBe(false);
    await expect(service.deleteBranchGuarded('proj', 'risky', false)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('confirm deleting unpushed work') });
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/risky')).resolves.toContain('refs/heads/risky');
    await expect(service.deleteBranchGuarded('proj', 'risky', true)).resolves.toEqual({ ok: true });

    await expect(service.deleteBranchGuarded('proj', 'main', true)).resolves.toMatchObject({ ok: false, error: 'the default branch cannot be deleted' });
  });

  it('reports dirty checked-out branches and refuses to delete them', async () => {
    const { root, service } = await repository();
    const worktree = `${root}-worktrees/occupied`;
    await git(root, 'worktree', 'add', '-q', '-b', 'occupied', worktree, 'main');
    await writeFile(join(worktree, 'unfinished.txt'), 'unfinished\n');

    await expect(service.branchRemoval('proj', 'occupied')).resolves.toEqual({ ok: true, facts: { branch: 'occupied', checkedOut: true, dirtyCount: 1, pushed: false, merged: true, defaultBranch: false } });
    await expect(service.deleteBranchGuarded('proj', 'occupied', true)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('uncommitted changes') });
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/occupied')).resolves.toContain('refs/heads/occupied');
  });
});
