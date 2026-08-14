import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type ConfiguredWorktree = { id: string; label: string; push?: { label: string; prompt: string } };

describe('local push actions', () => {
  it('uses finish for Potato workspaces and push for Ferry FYI', async () => {
    const config = JSON.parse(await readFile(new URL('../../../config/remote-agent-console.docker.json', import.meta.url), 'utf8')) as { worktrees: ConfiguredWorktree[] };
    const potatoes = config.worktrees.filter(worktree => worktree.label.startsWith('🥔'));

    // validate any configured Potato workspace without requiring this host to mount one
    expect(potatoes.every(worktree => worktree.push?.label === 'Finish and PR' && worktree.push.prompt === '$finish')).toBe(true);
    expect(config.worktrees.find(worktree => worktree.id === 'ferry-fyi')?.push).toEqual({ label: 'Commit/Push', prompt: '$push' });
    expect(config.worktrees.find(worktree => worktree.id === 'remoteagents')?.push).toBeUndefined();
  });
});
