import { afterEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { LaunchService, composeCommand, expandCommand, expandHomeCommand, scratchLabel } from '../src/launch/service.js';
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

  it('appends adapter args to the program, shell-quoting only unsafe ones', () => {
    // safe flags and validated ids stay legible; nothing appended for a fresh launch
    expect(composeCommand('codex', [])).toBe('codex');
    expect(composeCommand('codex', ['resume', '--last'])).toBe('codex resume --last');
    // an arg with shell metacharacters is single-quoted, with embedded quotes escaped
    expect(composeCommand('codex', ['a b', "x'y", '$(whoami)'])).toBe("codex 'a b' 'x'\\''y' '$(whoami)'");
  });

  it('continues a worktree with codex resume --last instead of a shell alias', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, command: 'codex' };
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect(service.resume(worktree.id)).resolves.toBe(true);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'codex resume --last']);
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

  it('resumes an exact conversation with codex resume <id> when no template is configured', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    // any launchable codex worktree can resume through its Adapter, no resumeCommand required
    expect(service.canResumeConversation(worktree.id)).toBe(true);
    expect(service.canResumeConversation('absent')).toBe(false);
    await expect(service.resumeConversation(worktree.id, '0198c333-3333-7333-8333-333333333333')).resolves.toBe(true);
    // a malformed id never reaches the shell
    await expect(service.resumeConversation(worktree.id, 'bad; rm -rf /')).resolves.toBe(false);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'codex resume 0198c333-3333-7333-8333-333333333333']);
    expect(calls).toHaveLength(2);
  });

  it('marks home-launched agents as Scratch without replacing their tmux title', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const service = new LaunchService({ newAgentCommand: 'codex', worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, command: 'codex' }] } as never);

    await expect(service.launchHome()).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', expect.stringMatching(/^rac-[\w-]+$/u), '@rac_display_label', scratchLabel]);
  });

  it('launches a dedicated update advisor in the fixed repository', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const service = new LaunchService({ newAgentCommand: 'codex --dangerously-bypass-approvals-and-sandbox', worktrees: [{ hostPath: '/home/ubuntu/remoteagents' }] } as never);

    await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-c', '/home/ubuntu/remoteagents']));
    const command = (run.mock.calls[0]?.[1] as string[]).join(' ');
    expect(command).toContain('command codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen');
    expect(command).toContain("export HOME='/home/ubuntu'");
    expect(command).not.toContain("export HOME='/home/ubuntu/remoteagents'");
    expect(command).not.toContain('--sandbox read-only');
    expect(command).not.toContain('--ask-for-approval never');
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', expect.stringMatching(/^rac-[\w-]+$/u), '@rac_display_label', 'Update Advisor Starting v4 2222222']);
  });

  it('restores an explicitly configured host PATH before starting a host pane', () => {
    expect(hostCommand('exec codex', '/home/ubuntu', '/opt/node/bin:/usr/bin:/bin')).toContain("export PATH='/opt/node/bin:/usr/bin:/bin'");
    expect(hostCommand('exec codex', '/home/ubuntu')).not.toContain('export PATH=');
  });

  it('composes fresh and continue launches into the exact host new-session argv', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_INTERACTIVE_SHELL;
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [] });

    await expect(service.launch('cora')).resolves.toBe(true);
    const freshSession = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(freshSession.slice(0, 9)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'cora', '-c', '/home/ubuntu/cora', '/usr/bin/zsh']);
    expect(freshSession[9]).toBe('-lc');
    // a fresh launch runs the configured command unchanged — no resume verb
    expect(freshSession[10]).toContain('codex');
    expect(freshSession[10]).not.toContain('resume');

    run.mockClear();
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(service.resume('cora')).resolves.toBe(true);
    const continueSession = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    // continue appends the Adapter's args to the same program
    expect(continueSession[10]).toContain('codex resume --last');
  });

  it('records @rac_sandboxed on a Sandboxed launch and leaves an ordinary launch unmarked', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [] });
    const launchWorktree = (input: { mode: 'fresh'; sandboxed?: boolean }) => (service as unknown as { launchWorktree(id: string, input: unknown): Promise<boolean> }).launchWorktree('cora', input);

    await expect(launchWorktree({ mode: 'fresh', sandboxed: true })).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', 'cora', '@rac_sandboxed', '1']);

    run.mockClear();
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(service.launch('cora')).resolves.toBe(true);
    expect(run).not.toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['@rac_sandboxed']));
  });

  it('records @rac_sandboxed on the reused pane for a Sandboxed reuse-launch', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async () => true, enter: async () => true };
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never);

    await expect((service as unknown as { launchWorktree(id: string, input: unknown): Promise<boolean> }).launchWorktree('cora', { mode: 'fresh', sandboxed: true })).resolves.toBe(true);
    // the reused-pane branch marks the pane id on the pane's own socket
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%4', '@rac_sandboxed', '1']);
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

  it('reuses an existing shell whose git toplevel is the worktree, even from a subdirectory', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'alex', label: 'Alex', path: '/worktrees/alex', identity: '/worktrees/alex', hostPath: '/home/ubuntu/alex', available: true, command: 'alex' };
    const calls: string[][] = [];
    const finder = { find: async () => [socket] };
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: '/home/ubuntu/alex/src', command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    // the subdirectory shares the worktree's toplevel, so it belongs to the worktree
    const paneRoot = async (path: string) => path === '/home/ubuntu/alex/src' ? '/home/ubuntu/alex' : path;
    const service = new LaunchService({ worktrees: [worktree] } as never, finder, panes as never, paneRoot);

    await expect(service.launch('alex')).resolves.toBe(true);
    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), 'alex']);
    expect(calls[1]).toEqual(['enter', '%4']);
  });

  it('never hijacks a shell sitting in a nested checkout under the worktree', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'alex', label: 'Alex', path: '/worktrees/alex', identity: '/worktrees/alex', hostPath: '/home/ubuntu/alex', available: true, command: 'codex' };
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: '/home/ubuntu/alex/.claude/worktrees/3', command: 'zsh', title: '', socket }], pastePrompt: vi.fn(), enter: vi.fn() };
    // the nested checkout is its own git worktree — its toplevel is itself, not alex
    const paneRoot = async (path: string) => path;
    const service = new LaunchService({ worktrees: [worktree] } as never, { find: async () => [socket] }, panes as never, paneRoot);

    await expect(service.launch('alex')).resolves.toBe(true);

    // the nested checkout is left alone; the console starts a fresh session instead
    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'alex', '-c', '/home/ubuntu/alex']));
  });

  it('lists panes on every socket concurrently and prefers the first socket', async () => {
    const first: SocketRef = { fingerprint: 'first', path: '/host-tmux/first', device: 1, inode: 1 };
    const second: SocketRef = { fingerprint: 'second', path: '/host-tmux/second', device: 1, inode: 2 };
    const worktree: Worktree = { id: 'alex', label: 'Alex', path: '/worktrees/alex', identity: '/worktrees/alex', hostPath: '/home/ubuntu/alex', available: true, command: 'alex' };
    const calls: string[][] = [];
    const started: string[] = [];
    const finder = { find: async () => [first, second] };
    const pane = (socket: SocketRef, id: string) => ({ paneId: id, sessionId: '$1', pid: 123, path: '/home/ubuntu/alex', command: 'zsh', title: '', socket });
    const panes = {
      // the first socket answers last; a sequential scan would still finish it first, a concurrent scan must not wait to start the second
      listPanes: async (socket: SocketRef) => { started.push(socket.fingerprint); await new Promise(resolve => setTimeout(resolve, socket === first ? 20 : 0)); return [pane(socket, socket === first ? '%1' : '%2')]; },
      pastePrompt: async (socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', socket.fingerprint, pane, buffer, command]); return true; },
      enter: async (socket: SocketRef, pane: string) => { calls.push(['enter', socket.fingerprint, pane]); return true; }
    };
    const service = new LaunchService({ worktrees: [worktree] } as never, finder, panes as never);

    const launch = service.launch('alex');
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    await expect(launch).resolves.toBe(true);
    expect(calls[0]).toMatchObject(['paste', 'first', '%1', expect.stringMatching(/^rac-launch-/), 'alex']);
    expect(calls[1]).toEqual(['enter', 'first', '%1']);
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
