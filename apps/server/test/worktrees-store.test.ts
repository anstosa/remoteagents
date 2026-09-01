import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeLaunchStore, scratchLaunchKey } from '../src/worktrees/store.js';

const dirs: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'rac-worktrees-'));
  dirs.push(root);
  const file = join(root, 'worktrees.json');
  return { file, store: new WorktreeLaunchStore({ file }) };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('WorktreeLaunchStore', () => {
  it('remembers and reads a per-worktree launch profile, persisting atomically', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.launchProfile('cora')).toBeUndefined();
    await worktrees.rememberLaunchProfile('cora', 'codex');
    expect(await worktrees.launchProfile('cora')).toBe('codex');
    // the scratch group is keyed independently and survives reload
    await worktrees.rememberLaunchProfile(scratchLaunchKey, 'codex');
    expect(await new WorktreeLaunchStore({ file }).launchProfile(scratchLaunchKey)).toBe('codex');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ cora: { launchProfile: 'codex' }, scratch: { launchProfile: 'codex' } });
  });

  it('ignores unsafe keys and unknown kinds instead of persisting them', async () => {
    const { file, store: worktrees } = await store();
    await worktrees.rememberLaunchProfile('bad key', 'codex');
    await worktrees.rememberLaunchProfile('cora', 'bogus' as never);
    expect(await worktrees.launchProfile('bad key')).toBeUndefined();
    expect(await worktrees.launchProfile('cora')).toBeUndefined();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a structurally invalid storage file', async () => {
    const { file, store: worktrees } = await store();
    await writeFile(file, JSON.stringify({ cora: { launchProfile: 'nope' } }));
    await expect(worktrees.launchProfile('cora')).rejects.toThrow('invalid worktrees file');
  });
});
