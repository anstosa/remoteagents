import { describe, expect, it } from 'vitest';

import { configuredWorktreeForWorkspace, worktreeHostRoot, worktreeMatchesWorkspace } from '../src/workspaces/resolver.js';
import type { Worktree } from '../src/domain/models.js';

const worktree = (over: Partial<Worktree> = {}): Worktree => ({ id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex', ...over });

describe('worktreeMatchesWorkspace', () => {
  it('matches the console-side git toplevel exactly', () => {
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora')).toBe(true);
  });

  it('matches the bridge host path when the worktree is mounted from the host', () => {
    expect(worktreeMatchesWorkspace(worktree({ hostPath: '/home/ubuntu/cora' }), '/home/ubuntu/cora')).toBe(true);
  });

  it('never associates a nested checkout or subdirectory by prefix', () => {
    // a `.claude/worktrees/<n>` created by the agent's own tool is its own toplevel
    expect(worktreeMatchesWorkspace(worktree({ hostPath: '/home/ubuntu/cora' }), '/home/ubuntu/cora/.claude/worktrees/3')).toBe(false);
    // an ordinary subdirectory reports the toplevel, not itself, so it should never reach here — but if it does, no match
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora/packages/app')).toBe(false);
    // a submodule pane resolves to the submodule's own toplevel, which is not this worktree
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora/vendor/lib')).toBe(false);
  });
});

describe('configuredWorktreeForWorkspace', () => {
  const worktrees = [worktree(), worktree({ id: 'nova', label: 'Nova', path: '/worktrees/nova', identity: '/worktrees/nova', hostPath: '/home/ubuntu/nova' })];

  it('resolves an unambiguous worktree by identity or host path', () => {
    expect(configuredWorktreeForWorkspace(worktrees, '/worktrees/cora')?.id).toBe('cora');
    expect(configuredWorktreeForWorkspace(worktrees, '/home/ubuntu/nova')?.id).toBe('nova');
  });

  it('returns undefined for a workspace no configured worktree owns', () => {
    expect(configuredWorktreeForWorkspace(worktrees, '/worktrees/cora/src')).toBeUndefined();
    expect(configuredWorktreeForWorkspace(worktrees, '/some/scratch/dir')).toBeUndefined();
  });
});

describe('worktreeHostRoot', () => {
  it('prefers the bridge host path when the worktree is mounted from the host', () => {
    expect(worktreeHostRoot(worktree({ hostPath: '/home/ubuntu/cora' }))).toBe('/home/ubuntu/cora');
  });

  it('falls back to the console git toplevel when no host path is configured', () => {
    expect(worktreeHostRoot(worktree())).toBe('/worktrees/cora');
  });
});
