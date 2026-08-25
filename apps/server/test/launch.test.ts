import { afterEach, describe, expect, it, vi } from 'vitest';

const { run, expandLaunch } = vi.hoisted(() => ({ run: vi.fn(), expandLaunch: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));
vi.mock('../src/config/schema.js', () => ({ expandLaunch }));

import { LaunchService, expandCommand, expandHomeCommand, scratchLabel } from '../src/launch/service.js';
import { hostCommand } from '../src/tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../src/tmux/session-name.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';

const hostTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const hostInteractiveShell = process.env.RAC_HOST_INTERACTIVE_SHELL;
const hostPath = process.env.RAC_HOST_PATH;
afterEach(() => {
  run.mockReset();
  if (hostTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = hostTmuxDirectory;
  if (hostInteractiveShell === undefined) delete process.env.RAC_HOST_INTERACTIVE_SHELL;
  else process.env.RAC_HOST_INTERACTIVE_SHELL = hostInteractiveShell;
  if (hostPath === undefined) delete process.env.RAC_HOST_PATH;
  else process.env.RAC_HOST_PATH = hostPath;
});

describe('LaunchService', () => {
  it('launches configured Codex worktrees through the interactive zsh environment', () => {
    const command = expandCommand('codex', { identity: '/worktrees/cora' });

    expect(command).toBe("cd -- '/worktrees/cora' && eval 'codex'");
    expect(command).not.toContain('RAC_CODEX_BIN');
    expect(command).not.toContain('$HOME/n/bin/codex');
  });

  it('runs a new-agent command through the configured shell aliases', () => {
    expect(expandHomeCommand('codex', '/home/ubuntu')).toContain("cd -- '/home/ubuntu' && eval 'codex'");
  });

  it('wakes a worktree through the resume alias', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, command: 'codex' };
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.resume(worktree.id)).resolves.toBe(true);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'resume']);
    expect(calls[1]).toEqual(['enter', '%4']);
  });

  it('resumes a bookmarked Codex conversation through its explicit template', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex', resumeCommand: 'codex resume {threadId} -C .' };
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.resumeConversation(worktree.id, '0198c333-3333-7333-8333-333333333333')).resolves.toBe(true);
    await expect(service.resumeConversation(worktree.id, 'bad; rm -rf /')).resolves.toBe(false);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'codex resume 0198c333-3333-7333-8333-333333333333 -C .']);
    expect(calls[1]).toEqual(['enter', '%4']);
    expect(calls).toHaveLength(2);
  });

  it('rejects exact resume before launch when no resume template is configured', async () => {
    const worktree: Worktree = { id: 'legacy', label: 'Legacy', path: '/worktrees/legacy', identity: '/worktrees/legacy', available: true, pinned: false, launch: { program: '/bin/echo', args: ['{worktreePath}'] } };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [] });

    expect(service.canResumeConversation(worktree.id)).toBe(false);
    await expect(service.resumeConversation(worktree.id, '0198c333-3333-7333-8333-333333333333')).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('marks home-launched agents as Scratch without replacing their tmux title', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const service = new LaunchService({ newAgentCommand: 'codex', worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, command: 'codex' }] } as never);

    await expect(service.launchHome()).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', expect.stringMatching(/^rac-[\w-]+$/u), '@rac_display_label', scratchLabel]);
  });

  it('restores an explicitly configured host PATH before starting a host pane', () => {
    expect(hostCommand('exec codex', '/home/ubuntu', '/opt/node/bin:/usr/bin:/bin')).toContain("export PATH='/opt/node/bin:/usr/bin:/bin'");
    expect(hostCommand('exec codex', '/home/ubuntu')).not.toContain('export PATH=');
  });

  it('names a new tmux session after the worktree directory', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree: Worktree = { id: 'ferry-fyi', label: 'Ferry FYI', path: '/worktrees/ferry.fyi', identity: '/worktrees/ferry.fyi', hostPath: '/home/ubuntu/ferry.fyi', available: true, pinned: false, command: 'codex' };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [] });

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'ferry.fyi', '-c', worktree.hostPath]));
  });

  it('moves a colliding named session aside before launching a worktree agent', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run
      .mockResolvedValueOnce({ code: 0, stdout: '$42\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'owen\n', stderr: '' })
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree: Worktree = { id: 'owen', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', hostPath: '/home/ubuntu/owen', available: true, pinned: true, command: 'codex' };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [] });

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(run.mock.calls[0]?.[1]).toEqual(['-S', '/host-tmux/default', 'display-message', '-p', '-t', '=owen:', '#{session_id}']);
    expect(run.mock.calls[2]?.[1]).toEqual(['-S', '/host-tmux/default', 'rename-session', '-t', '$42', expect.stringMatching(/^rac-replacing-[a-f0-9]+$/u)]);
    expect(run.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'owen', '-c', worktree.hostPath]));
  });

  it('preserves ordinary worktree names and removes tmux target separators', () => {
    expect(worktreeSessionName('/home/ubuntu/owen')).toBe('owen');
    expect(worktreeSessionName('/home/ubuntu/feature:demo')).toBe('feature-demo');
  });

  it('moves an existing dotted session aside by stable id while replacing it', async () => {
    run
      .mockResolvedValueOnce({ code: 0, stdout: '$42\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'ferry.fyi\n', stderr: '' })
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await expect(startNamedReplacementSession('/usr/bin/tmux', '/tmp/tmux', 'ferry.fyi', 'ferry.fyi', ['-c', '/home/ubuntu/ferry.fyi', 'codex'])).resolves.toBe(true);

    expect(run.mock.calls[0]?.[1]).toEqual(['-S', '/tmp/tmux', 'display-message', '-p', '-t', '=ferry.fyi:', '#{session_id}']);
    expect(run.mock.calls[1]?.[1]).toEqual(['-S', '/tmp/tmux', 'display-message', '-p', '-t', '$42', '#{session_name}']);
    expect(run.mock.calls[2]?.[1]).toEqual(['-S', '/tmp/tmux', 'rename-session', '-t', '$42', expect.stringMatching(/^rac-replacing-[a-f0-9]+$/u)]);
    expect(run.mock.calls[3]?.[1]).toEqual(['-S', '/tmp/tmux', 'new-session', '-d', '-s', 'ferry.fyi', '-c', '/home/ubuntu/ferry.fyi', 'codex']);
  });

  it('restores the old session name when its replacement cannot start', async () => {
    run
      .mockResolvedValueOnce({ code: 0, stdout: '$42\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'owen\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'failed' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await expect(startNamedReplacementSession('/usr/bin/tmux', '/tmp/tmux', '$1', 'owen', ['codex'])).resolves.toBe(false);

    expect(run.mock.calls[4]?.[1]).toEqual(['-S', '/tmp/tmux', 'rename-session', '-t', '$42', 'owen']);
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

  it('does not start an agent from an existing Bash pane', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'owen', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', hostPath: '/home/ubuntu/owen', available: true, command: 'codex' };
    const panes = {
      listPanes: async () => [{ paneId: '%4', sessionId: '$1', sessionName: 'operator-bash', pid: 123, path: '/home/ubuntu/owen', command: 'bash', title: '', socket }],
      pastePrompt: vi.fn(),
      enter: vi.fn()
    };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.launch('owen')).resolves.toBe(true);

    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
  });

  it('reuses an existing pane for the configured host shell', async () => {
    process.env.RAC_HOST_INTERACTIVE_SHELL = '/bin/bash';
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'bash-project', label: 'Bash project', path: '/worktrees/bash-project', identity: '/worktrees/bash-project', hostPath: '/home/operator/bash-project', available: true, command: 'codex' };
    const panes = { listPanes: async () => [{ paneId: '%7', sessionId: '$7', pid: 456, path: worktree.hostPath!, command: 'bash', title: '', socket }], pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true) };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(panes.pastePrompt).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not launch Owen inside a transient stack command session', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'owen', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', hostPath: '/home/ubuntu/owen', available: true, command: 'codex' };
    const panes = {
      listPanes: async () => [{ paneId: '%4', sessionId: '$1', sessionName: 'rac-stack-owen-a1b2c3', pid: 123, path: '/home/ubuntu/owen', command: 'bash', title: '', socket }],
      pastePrompt: vi.fn(),
      enter: vi.fn()
    };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.launch('owen')).resolves.toBe(true);

    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'owen', '-c', '/home/ubuntu/owen']));
  });
});
