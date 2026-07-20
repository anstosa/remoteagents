import { describe, expect, it } from 'vitest';
import { LaunchService, expandCommand, expandHomeCommand, hostCommand } from '../src/launch/service.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';

describe('LaunchService', () => {
  it('launches configured Codex worktrees with the real binary instead of the shell alias wrapper', () => {
    expect(expandCommand('codex', { identity: '/worktrees/cora' })).toContain('exec "${RAC_CODEX_BIN:-$HOME/n/bin/codex}"');
  });

  it('runs a new-agent command through the configured shell aliases', () => {
    expect(expandHomeCommand('codex', '/home/ubuntu')).toContain("cd -- '/home/ubuntu' && eval 'codex'");
  });

  it('restores the host Node and OMX PATH before starting a host pane', () => {
    expect(hostCommand('exec codex', '/home/ubuntu')).toContain('export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"');
  });

  it('uses an existing pane in the configured worktree before creating a session', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'alex', label: 'Alex', path: '/worktrees/alex', identity: '/worktrees/alex', hostPath: '/home/ubuntu/alex', available: true, command: 'alex' };
    const calls: string[][] = [];
    const finder = { find: async () => [socket] };
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: '/home/ubuntu/alex/src', command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService({ worktrees: [worktree] } as never, finder, panes as never);

    await expect(service.launch('alex')).resolves.toBe(true);
    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'alex']);
    expect(calls[1]).toEqual(['enter', '%4']);
  });
});
