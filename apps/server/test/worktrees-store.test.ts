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

// a Worktree wire id keyed by `<projectId>:<realpath>`
const cora = 'proj:/worktrees/cora';

describe('WorktreeLaunchStore', () => {
  it('remembers and reads a per-worktree launch profile by wire id, persisting atomically', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    await worktrees.rememberLaunchProfile(cora, 'codex');
    expect(await worktrees.launchProfile(cora)).toBe('codex');
    // the scratch group is keyed independently and survives reload
    await worktrees.rememberLaunchProfile(scratchLaunchKey, 'codex');
    expect(await new WorktreeLaunchStore({ file }).launchProfile(scratchLaunchKey)).toBe('codex');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [cora]: { launchProfile: 'codex' }, scratch: { launchProfile: 'codex' } });
  });

  it('reads every remembered profile in one snapshot for the dashboard', async () => {
    const { store: worktrees } = await store();
    expect(await worktrees.launchProfiles()).toEqual({});
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.rememberLaunchProfile(scratchLaunchKey, 'claude');
    // the snapshot maps each key to its kind, not to the stored record
    expect(await worktrees.launchProfiles()).toEqual({ [cora]: 'codex', scratch: 'claude' });
  });

  it('records and reads explicit pin overrides beside the launch profile', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.pins()).toEqual({});
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.setPinned(cora, false);
    await worktrees.setPinned('proj:/worktrees/dana', true);
    // only explicit overrides are stored; discovery applies the main-pinned default otherwise
    expect(await worktrees.pins()).toEqual({ [cora]: false, 'proj:/worktrees/dana': true });
    // pin and profile share one record for the Worktree
    expect(JSON.parse(await readFile(file, 'utf8'))[cora]).toEqual({ launchProfile: 'codex', pinned: false });
  });

  it('ignores unsafe keys and unknown kinds instead of persisting them', async () => {
    const { file, store: worktrees } = await store();
    await worktrees.rememberLaunchProfile('has\nnewline', 'codex');
    await worktrees.setPinned('has\0nul', true);
    await worktrees.rememberLaunchProfile(cora, 'bogus' as never);
    expect(await worktrees.launchProfile('has\nnewline')).toBeUndefined();
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists every stored key and deletes one record outright', async () => {
    const { store: worktrees } = await store();
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.setPinned('proj:/worktrees/dana', true);
    expect((await worktrees.keys()).sort()).toEqual([cora, 'proj:/worktrees/dana']);
    // Remove deletes the whole record — both the pin and the last-used kind go
    await worktrees.delete(cora);
    expect(await worktrees.keys()).toEqual(['proj:/worktrees/dana']);
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    // an unsafe key is a no-op, never a throw
    await worktrees.delete('has\nnewline');
    expect(await worktrees.keys()).toEqual(['proj:/worktrees/dana']);
  });

  it('rejects a structurally invalid storage file', async () => {
    const { file, store: worktrees } = await store();
    await writeFile(file, JSON.stringify({ [cora]: { launchProfile: 'nope' } }));
    await expect(worktrees.launchProfile(cora)).rejects.toThrow('invalid worktrees file');
  });
});
