import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchService, composeCommand, composeLaunch, expandCommand, expandHomeCommand, scratchLabel } from '../src/launch/service.js';
import { hostCommand } from '../src/tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../src/tmux/session-name.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';
import { testWorktree } from './helpers/config.js';

// worktrees are discovered and launched through a configured Adapter now; the legacy
// per-worktree `command`/`resumeCommand` launch path is retired, so a worktree launch
// needs `adapters.codex`. The discovered worktree reaches the service through the
// `discoveredWorktrees` provider (its 6th constructor argument), not config.
const codexProgram = '/usr/local/bin/codex';
const codex = { adapters: { codex: { program: codexProgram, args: [] as string[], env: {}, launchable: true } }, projects: [] } as never;
const cora = (over: Partial<Worktree> = {}) => testWorktree({ id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, ...over });

const hostTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const hostInteractiveShell = process.env.RAC_HOST_INTERACTIVE_SHELL;
const hostPath = process.env.RAC_HOST_PATH;
const adapterFilesDir = process.env.RAC_ADAPTER_FILES_DIR;
const tempDirs: string[] = [];
// default external tmux operations to success
beforeEach(() => { run.mockResolvedValue({ code: 0, stdout: '', stderr: '' }); });
afterEach(async () => {
  run.mockReset();
  if (hostTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = hostTmuxDirectory;
  if (hostInteractiveShell === undefined) delete process.env.RAC_HOST_INTERACTIVE_SHELL;
  else process.env.RAC_HOST_INTERACTIVE_SHELL = hostInteractiveShell;
  if (hostPath === undefined) delete process.env.RAC_HOST_PATH;
  else process.env.RAC_HOST_PATH = hostPath;
  if (adapterFilesDir === undefined) delete process.env.RAC_ADAPTER_FILES_DIR;
  else process.env.RAC_ADAPTER_FILES_DIR = adapterFilesDir;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
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
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect(service.resume(worktree.id)).resolves.toBe(true);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), `${codexProgram} resume --last`]);
    expect(calls[1]).toEqual(['enter', '%4']);
  });

  it('resumes an exact conversation with codex resume <id> through its Adapter', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    // any launchable codex worktree can resume through its Adapter; a template is no longer configured
    expect(service.canResumeConversation(worktree.id)).toBe(true);
    expect(service.canResumeConversation('absent')).toBe(false);
    await expect(service.resumeConversation(worktree.id, '0198c333-3333-7333-8333-333333333333')).resolves.toBe(true);
    // a malformed id never reaches the shell
    await expect(service.resumeConversation(worktree.id, 'bad; rm -rf /')).resolves.toBe(false);

    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), `${codexProgram} resume 0198c333-3333-7333-8333-333333333333`]);
    expect(calls).toHaveLength(2);
  });

  it('injects the rendered hooks settings into a Claude worktree launch', async () => {
    const filesDir = await mkdtemp(join(tmpdir(), 'rac-launch-files-'));
    tempDirs.push(filesDir);
    process.env.RAC_ADAPTER_FILES_DIR = filesDir;
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    const config = { adapters: { claude: { program: '/usr/local/bin/claude', args: [], env: {}, launchable: true } }, projects: [] };
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
    const service = new LaunchService(config as never, { find: async () => [socket] }, panes as never, undefined, store as never, () => [worktree]);

    await expect(service.resume(worktree.id, 'claude')).resolves.toBe(true);

    // continue → --continue --settings <rendered hooks.json>, program prepended
    expect(calls[0]?.[3]).toBe(`/usr/local/bin/claude --continue --settings ${join(filesDir, 'claude', 'hooks.json')}`);
    expect(existsSync(join(filesDir, 'claude', 'hooks.json'))).toBe(true);
  });

  it('marks home-launched agents as Scratch without replacing their tmux title', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const service = new LaunchService({ newAgentCommand: 'codex', projects: [] } as never);

    await expect(service.launchHome()).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', expect.stringMatching(/^rac-[\w-]+$/u), '@rac_display_label', scratchLabel]);
  });

  it('launches a scratch agent in the configured scratchDirectory while HOME stays the account home', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    // a project hostPath makes the account home distinct from the scratch directory
    const config = { newAgentCommand: 'codex', scratchDirectory: '/srv/scratch', projects: [{ hostPath: '/host/home/code' }] };
    const service = new LaunchService(config as never);

    await expect(service.launchHome()).resolves.toBe(true);

    // tmux opens the pane in the configured directory (`-c`), not the account home
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['-c', '/srv/scratch']));
    // HOME the shell exports stays the account home (dirname of the hostPath), independent of the cwd
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining([expect.stringContaining("export HOME='/host/home'")]));
  });

  it('launches a dedicated update advisor in the fixed repository', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const service = new LaunchService({ adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }, projects: [{ hostPath: '/home/ubuntu/remoteagents' }] } as never);

    await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-c', '/home/ubuntu/remoteagents']));
    const command = (run.mock.calls[0]?.[1] as string[]).join(' ');
    expect(command).toContain('/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen');
    expect(command).toContain("export HOME='/home/ubuntu'");
    expect(command).not.toContain("export HOME='/home/ubuntu/remoteagents'");
    expect(command).not.toContain('--sandbox read-only');
    expect(command).not.toContain('--ask-for-approval never');
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', expect.stringMatching(/^rac-[\w-]+$/u), '@rac_display_label', 'Update Advisor Starting v4 2222222']);
  });

  it('gives the update advisor the configured codex setup, but not when RAC_CODEX_BIN overrides the program', async () => {
    const savedBin = process.env.RAC_CODEX_BIN;
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true, setup: 'rm -f .omx/state/session.json' } }, projects: [{ hostPath: '/home/ubuntu/remoteagents' }] };
    try {
      // the advisor is a codex-kind launch, so it gets the pre-launch repair
      delete process.env.RAC_CODEX_BIN;
      const service = new LaunchService(config as never);
      await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);
      // the setup string is carried into the launch (single-quote-escaped by the shell bootstrap)
      expect((run.mock.calls[0]?.[1] as string[]).join(' ')).toContain('rm -f .omx/state/session.json');

      // an override points the advisor at a different binary the setup was never configured alongside
      run.mockClear();
      process.env.RAC_CODEX_BIN = '/opt/other/codex';
      const overridden = new LaunchService(config as never);
      await expect(overridden.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);
      const command = (run.mock.calls[0]?.[1] as string[]).join(' ');
      expect(command).toContain('/opt/other/codex --dangerously-bypass-approvals-and-sandbox');
      expect(command).not.toContain('rm -f .omx/state/session.json');
    } finally {
      if (savedBin === undefined) delete process.env.RAC_CODEX_BIN; else process.env.RAC_CODEX_BIN = savedBin;
    }
  });

  it('refuses to launch the update advisor when no Codex binary is configured', async () => {
    const savedBin = process.env.RAC_CODEX_BIN;
    delete process.env.RAC_CODEX_BIN;
    try {
      // no adapters.codex and no RAC_CODEX_BIN means the advisor's Codex binary is unresolved
      const service = new LaunchService({ projects: [] } as never);
      await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (savedBin !== undefined) process.env.RAC_CODEX_BIN = savedBin;
    }
  });

  it('restores an explicitly configured host PATH before starting a host pane', () => {
    expect(hostCommand('exec codex', '/home/ubuntu', '/opt/node/bin:/usr/bin:/bin')).toContain("export PATH='/opt/node/bin:/usr/bin:/bin'");
    expect(hostCommand('exec codex', '/home/ubuntu')).not.toContain('export PATH=');
  });

  it('composes fresh and continue launches into the exact host new-session argv', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_INTERACTIVE_SHELL;
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora();
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.launch('cora')).resolves.toBe(true);
    const freshSession = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(freshSession.slice(0, 9)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'cora', '-c', '/home/ubuntu/cora', '/usr/bin/zsh']);
    expect(freshSession[9]).toBe('-lc');
    // a fresh launch runs the configured program unchanged — no resume verb
    expect(freshSession[10]).toContain('codex');
    expect(freshSession[10]).not.toContain('resume');

    run.mockClear();
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(service.resume('cora')).resolves.toBe(true);
    const continueSession = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    // continue appends the Adapter's args to the same program
    expect(continueSession[10]).toContain('codex resume --last');
  });

  // nested checkouts still use the authenticated host account
  it('keeps the account HOME when launching a nested host worktree', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora({
      id: 'worker-1',
      path: '/worktrees/cora/.omx/team/example/worktrees/worker-1',
      hostPath: '/home/ubuntu/cora/.omx/team/example/worktrees/worker-1'
    });
    const config = { ...codex, projects: [{ id: 'other', hostPath: '/home/other/repo' }, { id: 'proj', hostPath: '/home/ubuntu/cora' }] };
    const service = new LaunchService(config, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created).toContain(worktree.hostPath);
    expect(created.join(' ')).toContain("export HOME='/home/ubuntu'");
    expect(created.join(' ')).not.toContain("export HOME='/home/ubuntu/cora/.omx/team/example/worktrees'");
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', 'worker-1', '@rac_console_managed', '1']);
  });

  it('records @rac_sandboxed on a Sandboxed launch and leaves an ordinary launch unmarked', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora();
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);
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
    const worktree = cora();
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async () => true, enter: async () => true };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect((service as unknown as { launchWorktree(id: string, input: unknown): Promise<boolean> }).launchWorktree('cora', { mode: 'fresh', sandboxed: true })).resolves.toBe(true);
    // the reused-pane branch marks the pane id on the pane's own socket
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%4', '@rac_sandboxed', '1']);
  });

  it('names a new tmux session after the worktree directory', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora({ id: 'ferry-fyi', label: 'Ferry FYI', path: '/worktrees/ferry.fyi', hostPath: '/home/ubuntu/ferry.fyi' });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'ferry.fyi', '-c', worktree.hostPath]));
  });

  it('moves a colliding named session aside before launching a worktree agent', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run
      .mockResolvedValueOnce({ code: 0, stdout: '$42\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'owen\n', stderr: '' })
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora({ id: 'owen', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen', pinned: true });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(run.mock.calls[0]?.[1]).toEqual(['-S', '/host-tmux/default', 'display-message', '-p', '-t', '=owen:', '#{session_id}']);
    expect(run.mock.calls[2]?.[1]).toEqual(['-S', '/host-tmux/default', 'rename-session', '-t', '$42', expect.stringMatching(/^rac-replacing-[a-f0-9]+$/u)]);
    expect(run.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'owen', '-c', worktree.hostPath]));
  });

  it('starts a Worktree idle shell named after the checkout when the name is free', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockImplementation(async (_binary: string, args: string[]) => args.includes('list-sessions') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const worktree = cora({ id: 'owen', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen' });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.startWorktreeShell(worktree)).resolves.toBe(true);

    // the idle shell is a plain host new-session (no displacement), in the worktree dir
    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created.slice(0, 8)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'owen', '-c', '/home/ubuntu/owen']);
    expect(run.mock.calls.some(call => (call[1] as string[]).includes('rename-session'))).toBe(false);
  });

  // nested idle shells share the authenticated host account too
  it('keeps the account HOME when starting a nested worktree shell', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const worktree = cora({
      id: 'worker-1',
      path: '/worktrees/cora/.omx/team/example/worktrees/worker-1',
      hostPath: '/home/ubuntu/cora/.omx/team/example/worktrees/worker-1'
    });
    const config = { ...codex, projects: [{ id: 'other', hostPath: '/home/other/repo' }, { id: 'proj', hostPath: '/home/ubuntu/cora' }] };
    const service = new LaunchService(config, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.startWorktreeShell(worktree)).resolves.toBe(true);

    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created).toContain(worktree.hostPath);
    expect(created.join(' ')).toContain("export HOME='/home/ubuntu'");
    expect(created.join(' ')).not.toContain("export HOME='/home/ubuntu/cora/.omx/team/example/worktrees'");
  });

  it('suffixes the idle shell session name when a different worktree already holds it', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockImplementation(async (_binary: string, args: string[]) => args.includes('list-sessions') ? { code: 0, stdout: 'owen\nother\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const worktree = cora({ id: 'owen2', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen' });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.startWorktreeShell(worktree)).resolves.toBe(true);

    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created.slice(2, 6)).toEqual(['new-session', '-d', '-s', 'owen-2']);
  });

  it('keeps incrementing the idle shell suffix past a run of taken names', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockImplementation(async (_binary: string, args: string[]) => args.includes('list-sessions') ? { code: 0, stdout: 'owen\nowen-2\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const worktree = cora({ id: 'owen3', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen' });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.startWorktreeShell(worktree)).resolves.toBe(true);

    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created.slice(2, 6)).toEqual(['new-session', '-d', '-s', 'owen-3']);
  });

  it('starts a local idle shell as a plain login shell so its pane is reusable at once', async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    run.mockImplementation(async (_binary: string, args: string[]) => args.includes('list-sessions') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const worktree = testWorktree({ id: 'owen', projectId: 'proj', path: '/worktrees/owen', identity: '/worktrees/owen', main: false });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    await expect(service.startWorktreeShell(worktree)).resolves.toBe(true);

    // a direct login shell in the checkout — no node runner, no descriptor, no fs
    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created).toEqual(['new-session', '-d', '-s', 'owen', '-c', '/worktrees/owen', '/usr/bin/zsh', '-l']);
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
    const worktree = cora({ id: 'alex', label: 'Alex', path: '/worktrees/alex', hostPath: '/home/ubuntu/alex' });
    const calls: string[][] = [];
    const finder = { find: async () => [socket] };
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: '/home/ubuntu/alex/src', command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, buffer: string, command: string) => { calls.push(['paste', pane, buffer, command]); return true; }, enter: async (_socket: SocketRef, pane: string) => { calls.push(['enter', pane]); return true; } };
    // the subdirectory shares the worktree's toplevel, so it belongs to the worktree
    const paneRoot = async (path: string) => path === '/home/ubuntu/alex/src' ? '/home/ubuntu/alex' : path;
    const service = new LaunchService(codex, finder, panes as never, paneRoot, undefined, () => [worktree]);

    await expect(service.launch('alex')).resolves.toBe(true);
    expect(calls[0]).toMatchObject(['paste', '%4', expect.stringMatching(/^rac-launch-/), codexProgram]);
    expect(calls[1]).toEqual(['enter', '%4']);
  });

  it('never hijacks a shell sitting in a nested checkout under the worktree', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora({ id: 'alex', label: 'Alex', path: '/worktrees/alex', hostPath: '/home/ubuntu/alex' });
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: '/home/ubuntu/alex/.claude/worktrees/3', command: 'zsh', title: '', socket }], pastePrompt: vi.fn(), enter: vi.fn() };
    // the nested checkout is its own git worktree — its toplevel is itself, not alex
    const paneRoot = async (path: string) => path;
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, paneRoot, undefined, () => [worktree]);

    await expect(service.launch('alex')).resolves.toBe(true);

    // the nested checkout is left alone; the console starts a fresh session instead
    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'alex', '-c', '/home/ubuntu/alex']));
  });

  it('lists panes on every socket concurrently and prefers the first socket', async () => {
    const first: SocketRef = { fingerprint: 'first', path: '/host-tmux/first', device: 1, inode: 1 };
    const second: SocketRef = { fingerprint: 'second', path: '/host-tmux/second', device: 1, inode: 2 };
    const worktree = cora({ id: 'alex', label: 'Alex', path: '/worktrees/alex', hostPath: '/home/ubuntu/alex' });
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
    const service = new LaunchService(codex, finder, panes as never, undefined, undefined, () => [worktree]);

    const launch = service.launch('alex');
    // both scans must start before the slow first socket resolves (20ms); a sequential scan would leave 'second' unstarted
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(started).toEqual(['first', 'second']);
    await expect(launch).resolves.toBe(true);
    expect(calls[0]).toMatchObject(['paste', 'first', '%1', expect.stringMatching(/^rac-launch-/), codexProgram]);
    expect(calls[1]).toEqual(['enter', 'first', '%1']);
  });

  it('does not start an agent from an existing Bash pane', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora({ id: 'owen', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen' });
    const panes = {
      listPanes: async () => [{ paneId: '%4', sessionId: '$1', sessionName: 'operator-bash', pid: 123, path: '/home/ubuntu/owen', command: 'bash', title: '', socket }],
      pastePrompt: vi.fn(),
      enter: vi.fn()
    };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect(service.launch('owen')).resolves.toBe(true);

    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
  });

  it('reuses an existing pane for the configured host shell', async () => {
    process.env.RAC_HOST_INTERACTIVE_SHELL = '/bin/bash';
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora({ id: 'bash-project', label: 'Bash project', path: '/worktrees/bash-project', hostPath: '/home/operator/bash-project' });
    const panes = { listPanes: async () => [{ paneId: '%7', sessionId: '$7', pid: 456, path: worktree.hostPath!, command: 'bash', title: '', socket }], pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true) };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    expect(panes.pastePrompt).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%7', '@rac_console_managed', '1']);
  });

  it('does not launch Owen inside a transient stack command session', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora({ id: 'owen', label: 'Owen', path: '/worktrees/owen', hostPath: '/home/ubuntu/owen' });
    const panes = {
      listPanes: async () => [{ paneId: '%4', sessionId: '$1', sessionName: 'rac-stack-owen-a1b2c3', pid: 123, path: '/home/ubuntu/owen', command: 'bash', title: '', socket }],
      pastePrompt: vi.fn(),
      enter: vi.fn()
    };
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect(service.launch('owen')).resolves.toBe(true);

    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'owen', '-c', '/home/ubuntu/owen']));
  });

  it('composes [program, …adapter args, …operator args] with the merged env as a shell-quoted prefix', () => {
    // program and args quoted only when unsafe; adapter args precede operator args
    expect(composeLaunch('/usr/local/bin/codex', ['resume', '--last'], ['--model', 'o3'])).toBe('/usr/local/bin/codex resume --last --model o3');
    // operator env overlays adapter env; values are single-quoted, embedded quotes escaped
    expect(composeLaunch('/opt/my agent/bin', [], ['--x'], { A: '1', B: '2' }, { B: 'two', C: "x'y" })).toBe("A=1 B=two C='x'\\''y' '/opt/my agent/bin' --x");
  });

  it('wraps a configured setup in its own eval so a failing setup aborts the launch', () => {
    // the setup is its own command (own eval), gating the program through &&
    expect(composeLaunch('/usr/local/bin/codex', [], [], {}, {}, 'rm -f .omx/state/session.json')).toBe("eval 'rm -f .omx/state/session.json' && /usr/local/bin/codex");
    // the setup precedes the env prefix; both run inside the same pane eval
    expect(composeLaunch('/usr/local/bin/codex', ['resume', '--last'], [], { A: '1' }, {}, 'true')).toBe('eval true && A=1 /usr/local/bin/codex resume --last');
    // a compound setup cannot re-associate the && and skip the program: it stays inside its eval
    expect(composeLaunch('/usr/local/bin/codex', [], [], {}, {}, 'test -f marker || ./repair.sh')).toBe("eval 'test -f marker || ./repair.sh' && /usr/local/bin/codex");
    // without a setup the composition is byte-identical to the setup-less call
    expect(composeLaunch('/usr/local/bin/codex', ['resume', '--last'], ['--model', 'o3'], {}, {}, undefined)).toBe('/usr/local/bin/codex resume --last --model o3');
  });

  it('launches a configured kind through its program, appending operator args and env', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, _buffer: string, command: string) => { calls.push(['paste', pane, command]); return true; }, enter: async () => true };
    const remembered: Array<[string, string]> = [];
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async (key: string, kind: string) => { remembered.push([key, kind]); } };
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: ['--search'], env: { RAC_X: '1' }, launchable: true } }, projects: [] };
    const service = new LaunchService(config as never, { find: async () => [socket] }, panes as never, undefined, store as never, () => [worktree]);

    await expect(service.launch('cora')).resolves.toBe(true);

    // fresh launch: no adapter mode args, operator's --search appended, env prefixed
    expect(calls[0]).toEqual(['paste', '%4', 'RAC_X=1 /usr/local/bin/codex --search']);
    // the resolved kind is recorded for this Worktree and its Project
    expect(remembered).toEqual([['cora', 'codex'], ['proj', 'codex']]);
  });

  it('runs a configured setup command before the program in the launched pane', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, _buffer: string, command: string) => { calls.push(['paste', pane, command]); return true; }, enter: async () => true };
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true, setup: 'rm -f .omx/state/session.json' } }, projects: [] };
    const service = new LaunchService(config as never, { find: async () => [socket] }, panes as never, undefined, store as never, () => [worktree]);

    await expect(service.launch('cora')).resolves.toBe(true);

    // the setup runs first in the same pane; its non-zero exit would stop the program
    expect(calls[0]).toEqual(['paste', '%4', "eval 'rm -f .omx/state/session.json' && /usr/local/bin/codex"]);
  });

  it('composes an OMX launch from adapters.omx: the setup, then the program with --direct and the mode arguments', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora();
    const calls: string[][] = [];
    const panes = { listPanes: async () => [{ paneId: '%4', sessionId: '$1', pid: 123, path: worktree.hostPath!, command: 'zsh', title: '', socket }], pastePrompt: async (_socket: SocketRef, pane: string, _buffer: string, command: string) => { calls.push(['paste', pane, command]); return true; }, enter: async () => true };
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
    // the OMX-on-ZFS configuration: plain Codex stays on adapters.codex, OMX carries the pointer cleanup
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true }, omx: { program: '/abs/omx', args: [], env: {}, launchable: true, setup: 'rm -f .omx/state/session.json' } }, projects: [] };
    const service = new LaunchService(config as never, { find: async () => [socket] }, panes as never, undefined, store as never, () => [worktree]);

    // with both configured and nothing remembered, Codex stays the default: OMX must be asked for
    await expect(service.resolveLaunchKind('cora')).resolves.toBe('codex');
    await expect(service.launch('cora', 'omx')).resolves.toBe(true);
    await expect(service.resume('cora', 'omx')).resolves.toBe(true);
    await expect(service.resumeConversation('cora', '0198c333-3333-7333-8333-333333333333', 'omx')).resolves.toBe(true);

    expect(calls.map(call => call[2])).toEqual([
      "eval 'rm -f .omx/state/session.json' && /abs/omx --direct",
      "eval 'rm -f .omx/state/session.json' && /abs/omx --direct resume --last",
      "eval 'rm -f .omx/state/session.json' && /abs/omx --direct resume 0198c333-3333-7333-8333-333333333333"
    ]);
  });

  it('refuses a requested kind that is not configured or launchable', async () => {
    const worktree = cora();
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }, projects: [] };
    const service = new LaunchService(config as never, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);

    // claude is a known kind but has no configured, registered adapter
    await expect(service.launch('cora', 'claude')).resolves.toBe(false);
    // an unlaunchable codex (non-executable program) is refused too
    const unlaunchable = new LaunchService({ adapters: { codex: { program: '/nope', args: [], env: {}, launchable: false } }, projects: [] } as never, { find: async () => [] }, undefined, undefined, undefined, () => [worktree]);
    await expect(unlaunchable.launch('cora')).resolves.toBe(false);
  });

  it('does not consult the store when a single kind can launch', async () => {
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }, projects: [] };
    const lookups: string[] = [];
    const store = { launchProfiles: async () => { lookups.push('read'); return {}; }, rememberLaunchProfile: async () => {} };
    const service = new LaunchService(config as never, { find: async () => [] }, undefined, undefined, store as never);
    // with a single launchable kind the store is not even consulted
    await service.resolveLaunchKind('cora');
    expect(lookups).toEqual([]);
  });
});
