import { describe, expect, it } from 'vitest';
import { DiscoveryService } from '../src/discovery/service.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';

describe('DiscoveryService dashboard', () => {
  it('associates host tmux paths with configured worktrees', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }] };
    const processes = { hasCodexDescendant: async () => true };
    const service = new DiscoveryService(finder, tmux as never, processes);
    const worktrees: Worktree[] = [{ id: 'ferry', label: 'Ferry FYI', path: '/worktrees/ferry', identity: '/worktrees/ferry', hostPath: '/host/ferry', available: true, command: 'codex', projectUrl: 'https://ferry.agents.example.com' }];

    const dashboard = await service.dashboard(worktrees);

    expect(dashboard.agents).toHaveLength(1);
    expect(dashboard.agents[0]).toMatchObject({ workspace: '/worktrees/ferry', worktreeId: 'ferry', worktreeLabel: 'Ferry FYI', worktreeOrder: 0, projectUrl: 'https://ferry.agents.example.com' });
    expect(dashboard.worktrees).toEqual([]);
  });
});
