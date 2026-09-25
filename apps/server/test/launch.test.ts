import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
// mock only the process spawner; keep the module's other helpers real
vi.mock('../src/tmux/command.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/tmux/command.js')>()), run }));

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchService, composeCommand, composeLaunch, expandCommand, expandHomeCommand, scratchLabel, type TmuxSession } from '../src/launch/service.js';
import { hostCommand, interactiveShellPath } from '../src/tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../src/tmux/session-name.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';
import { testWorktree } from './helpers/config.js';
import { worktreePlace } from '../src/places/places.js';

// worktrees are discovered and launched through a configured Adapter now; the legacy
// per-worktree `command`/`resumeCommand` launch path is retired, so a worktree launch
// needs `adapters.codex`. The discovered worktree reaches the service through the
// `discoveredWorktrees` provider (its 6th constructor argument), not config.
const codexProgram = '/usr/local/bin/codex';
const codex = { adapters: { codex: { program: codexProgram, args: [] as string[], env: {}, launchable: true } }, projects: [] } as never;
const cora = (over: Partial<Worktree> = {}) => testWorktree({ id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, ...over });

const codexBin = process.env.RAC_CODEX_BIN;
const hostTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const hostCodexBin = process.env.RAC_HOST_CODEX_BIN;
const hostInteractiveShell = process.env.RAC_HOST_INTERACTIVE_SHELL;
const hostPath = process.env.RAC_HOST_PATH;
const adapterFilesDir = process.env.RAC_ADAPTER_FILES_DIR;
const tempDirs: string[] = [];
// default external tmux operations to success
beforeEach(() => { run.mockResolvedValue({ code: 0, stdout: '', stderr: '' }); });
afterEach(async () => {
  run.mockReset();
  // restore process-wide launch overrides
  if (codexBin === undefined) delete process.env.RAC_CODEX_BIN;
  else process.env.RAC_CODEX_BIN = codexBin;
  if (hostTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = hostTmuxDirectory;
  if (hostCodexBin === undefined) delete process.env.RAC_HOST_CODEX_BIN;
  else process.env.RAC_HOST_CODEX_BIN = hostCodexBin;
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
    run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? '%5' : '', stderr: '' }));
    const service = new LaunchService(codex, { find: async () => [] });

    await expect(service.launchHome()).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['/usr/bin/zsh', '-lc', expect.stringContaining('source "$HOME/.zshrc"')]));
    // the pane is labelled, not retitled: its tmux title stays the agent's own
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%5', '@rac_display_label', scratchLabel]);
    expect(run.mock.calls.some(call => (call[1] as string[]).some(arg => arg.includes('pane_title') || arg === 'select-pane'))).toBe(false);
  });

  it('launches a scratch agent in the configured scratchDirectory while HOME stays the account home', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    // a project hostPath makes the account home distinct from the scratch directory
    const config = { adapters: { codex: { program: codexProgram, args: [], env: {}, launchable: true } }, scratchDirectory: '/srv/scratch', projects: [{ hostPath: '/host/home/code' }] };
    const service = new LaunchService(config as never);

    await expect(service.launchHome()).resolves.toBe(true);

    // tmux opens the pane in the configured directory (`-c`), not the account home
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['-c', '/srv/scratch']));
    // HOME the shell exports stays the account home (dirname of the hostPath), independent of the cwd
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining([expect.stringContaining("export HOME='/host/home'")]));
  });

  it('launches a non-git directory Project in place, labeled with the Project and remembering its kind', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? '%5' : '', stderr: '' }));
    const remembered: Array<[string, string]> = [];
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async (key: string, kind: string) => { remembered.push([key, kind]); } };
    const config = { adapters: { codex: { program: codexProgram, args: [], env: {}, launchable: true } }, projects: [{ id: 'notes', label: 'Notes', path: '/home/me/notes', identity: '/home/me/notes', mode: 'directory', available: true }] };
    const service = new LaunchService(config as never, { find: async () => [] }, undefined, undefined, store as never);

    await expect(service.launchProjectDirectory('notes')).resolves.toBe(true);

    // the pane opens in the Project directory, like Scratch (no worktree), in a session named for it
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'notes', '-c', '/home/me/notes']));
    // the new pane is labeled with the Project so its tab reads as the Project
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%5', '@rac_display_label', 'Notes']);
    // the resolved kind is remembered under the Project scope, seeding the next launch
    expect(remembered).toEqual([['notes', 'codex']]);
  });

  it('launches a directory Project at its host-visible path under the Docker bridge', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
    const config = { adapters: { codex: { program: codexProgram, args: [], env: {}, launchable: true } }, projects: [{ id: 'notes', label: 'Notes', path: '/container/notes', hostPath: '/host/notes', identity: '/container/notes', mode: 'directory', available: true }] };
    const service = new LaunchService(config as never, undefined, undefined, undefined, store as never);

    await expect(service.launchProjectDirectory('notes')).resolves.toBe(true);

    // the host tmux can only cd into the host-visible path, not the container path
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['-c', '/host/notes']));
  });

  it('refuses to launch a git repository Project, an unavailable directory, or an absent id in place', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const config = { adapters: { codex: { program: codexProgram, args: [], env: {}, launchable: true } }, projects: [
      { id: 'repo', label: 'Repo', path: '/repo', identity: '/repo/.git', mode: 'repository', available: true },
      { id: 'gone', label: 'Gone', path: '/gone', identity: '/gone', mode: 'directory', available: false }
    ] };
    const service = new LaunchService(config as never);

    // a git repository launches through its worktrees, not in place
    await expect(service.launchProjectDirectory('repo')).resolves.toBe(false);
    // an unavailable path has nothing to launch into
    await expect(service.launchProjectDirectory('gone')).resolves.toBe(false);
    await expect(service.launchProjectDirectory('absent')).resolves.toBe(false);
    // no session was ever spawned
    expect(run.mock.calls.some(call => (call[1] as string[]).includes('new-session'))).toBe(false);
  });

  it('launches a dedicated update advisor in the fixed repository', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_CODEX_BIN = '/container/bin/codex';
    process.env.RAC_HOST_CODEX_BIN = '/host/bin/codex';
    run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? '%5' : '', stderr: '' }));
    const service = new LaunchService({ adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }, projects: [{ hostPath: '/home/ubuntu/remoteagents' }] } as never);

    await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);
    // its own uniquely named session, never a Place's
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-s', expect.stringMatching(/^rac-[\w-]+$/u)]));

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-c', '/home/ubuntu/remoteagents']));
    const command = (run.mock.calls[0]?.[1] as string[]).join(' ');
    expect(command).toContain('/host/bin/codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen');
    expect(command).not.toContain('/container/bin/codex');
    expect(command).toContain("export HOME='/home/ubuntu'");
    expect(command).not.toContain("export HOME='/home/ubuntu/remoteagents'");
    expect(command).not.toContain('--sandbox read-only');
    expect(command).not.toContain('--ask-for-approval never');
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%5', '@rac_display_label', 'Update Advisor Starting v4 2222222']);
  });

  it('gives the host update advisor the configured codex setup, but not when RAC_HOST_CODEX_BIN overrides the program', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const config = { adapters: { codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true, setup: 'rm -f .omx/state/session.json' } }, projects: [{ hostPath: '/home/ubuntu/remoteagents' }] };
    // the configured host program gets its matching pre-launch repair
    process.env.RAC_HOST_CODEX_BIN = '   ';
    const service = new LaunchService(config as never);
    await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);
    expect((run.mock.calls[0]?.[1] as string[]).join(' ')).toContain('rm -f .omx/state/session.json');

    // a host override must not inherit setup for a different program
    run.mockClear();
    process.env.RAC_HOST_CODEX_BIN = '/opt/other/codex';
    const overridden = new LaunchService(config as never);
    await expect(overridden.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(true);
    const command = (run.mock.calls[0]?.[1] as string[]).join(' ');
    expect(command).toContain('/opt/other/codex --dangerously-bypass-approvals-and-sandbox');
    expect(command).not.toContain('rm -f .omx/state/session.json');
  });

  it('refuses to launch the update advisor when no Codex binary is configured', async () => {
    delete process.env.RAC_CODEX_BIN;
    // no adapters.codex and no RAC_CODEX_BIN means the direct advisor binary is unresolved
    const service = new LaunchService({ adapters: {}, projects: [] } as never);
    await expect(service.launchUpdateAdvisor('/home/ubuntu/remoteagents', '2'.repeat(40))).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
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

  it('suffixes a local worktree launch past a session name an unrelated tmux session already holds', async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const root = await mkdtemp(join(tmpdir(), 'rac-launch-'));
    tempDirs.push(root);
    // a stray, non-console session already holds the worktree's base name on the shared
    // default socket; the runner path must step around it, not collide on new-session
    run.mockImplementation(async (_binary: string, args: string[]) => args.includes('list-sessions') ? { code: 0, stdout: 'owen\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const worktree = testWorktree({ id: 'owen', projectId: 'proj', path: '/worktrees/owen', identity: '/worktrees/owen', main: false });
    const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree], () => new Set(), undefined, root);

    await expect(service.launch(worktree.id)).resolves.toBe(true);

    // launched under a suffixed name via the node runner, never the taken base name
    const created = run.mock.calls.find(call => (call[1] as string[]).includes('new-session'))?.[1] as string[];
    expect(created.slice(0, 5)).toEqual(['new-session', '-d', '-s', 'owen-2', process.execPath]);
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

  // keep modal shells outside worktree launches
  it('does not reuse a labeled update-advisor shell for a worktree launch', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const worktree = cora({ id: 'remoteagents', label: 'Remote Agents', path: '/workspace', hostPath: '/home/ubuntu/remoteagents' });
    const panes = {
      listPanes: vi.fn().mockResolvedValue([{ paneId: '%4', sessionId: '$1', sessionName: 'rac-advisor', pid: 123, path: worktree.hostPath, command: 'zsh', title: '', displayLabel: 'Update Advisor Starting v4 abc1234', socket }]),
      pastePrompt: vi.fn(),
      enter: vi.fn()
    };
    // expose the configured worktree
    const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

    await expect(service.resume(worktree.id)).resolves.toBe(true);

    expect(panes.pastePrompt).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['new-session', '-d', '-s', 'remoteagents', '-c', '/home/ubuntu/remoteagents']));
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

  describe('Console shells', () => {
    const alex = () => cora({ id: 'alex', label: 'Alex', path: '/worktrees/alex', hostPath: '/home/ubuntu/alex' });
    const shellPane = (over: Record<string, unknown>, socket: SocketRef) => ({ paneId: '%1', sessionId: '$1', pid: 1, path: '/home/ubuntu/alex', command: 'zsh', title: '', socket, ...over });

    it('opens a Console shell beside a live Agent as a detached window with cwd, a login shell and both marker options', async () => {
      // the argv contract: a detached window (`-d`), the Worktree cwd, a login shell, and the
      // two markers set at creation so a restart rediscovers the shell from them
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const socket: SocketRef = { fingerprint: 'sock', path: '/tmp/tmux/default', device: 1, inode: 1 };
      const worktree = alex();
      const service = new LaunchService(codex, { find: async () => [] }, undefined, undefined, undefined, () => [worktree], () => new Set(), async placeId => (placeId === 'alex' ? { socket, session: '$1' } : undefined));

      await expect(service.createConsoleShell(worktreePlace(worktree), 'build')).resolves.toBe('%9');

      const newWindow = run.mock.calls.find(call => call[1].includes('new-window'));
      expect(newWindow?.[1]).toEqual(['-S', '/tmp/tmux/default', 'new-window', '-d', '-t', '$1', '-c', '/worktrees/alex', '-P', '-F', '#{pane_id}', '--', interactiveShellPath(), '-l']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux/default', 'set-option', '-p', '-t', '%9', '@rac_role', 'shell']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux/default', 'set-option', '-p', '-t', '%9', '@rac_pane_name', 'build']);
    });

    it('opens the first Console shell in a fresh session named for the Worktree when there is no live Agent', async () => {
      run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? '%5' : '', stderr: '' }));
      const socket: SocketRef = { fingerprint: 'sock', path: '/tmp/tmux/default', device: 1, inode: 1 };
      const worktree = alex();
      const service = new LaunchService(codex, { find: async () => [socket] }, undefined, undefined, undefined, () => [worktree]);

      await expect(service.createConsoleShell(worktreePlace(worktree), '')).resolves.toBe('%5');

      const newSession = run.mock.calls.find(call => call[1].includes('new-session'));
      expect(newSession?.[1]).toEqual(['new-session', '-d', '-s', 'alex', '-c', '/worktrees/alex', '-P', '-F', '#{pane_id}', '--', interactiveShellPath(), '-l']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['set-option', '-p', '-t', '%5', '@rac_role', 'shell']);
    });

    it('never adopts a Console shell for a launch and joins its session instead', async () => {
      process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const worktree = alex();
      const panes = { listPanes: async () => [shellPane({ role: 'shell' }, socket)], pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true) };
      const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

      await expect(service.launch('alex')).resolves.toBe(true);

      expect(panes.pastePrompt).not.toHaveBeenCalled();
      // no adoptable idle shell: the launch adds a window to the session holding the Console shell
      const newWindow = run.mock.calls.find(call => call[1].includes('new-window'));
      expect(newWindow?.[1]).toEqual(expect.arrayContaining(['-S', '/host-tmux/default', 'new-window', '-d', '-t', '$1']));
    });

    it("launches a second Agent at a Worktree as a window in the running Agent's session, never replacing it", async () => {
      process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const worktree = alex();
      // the live Agent's pane runs the agent, not a shell, so nothing is adoptable
      const panes = { listPanes: async () => [shellPane({ command: 'codex' }, socket)], pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true) };
      const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree], () => new Set(), async placeId => (placeId === 'alex' ? { socket, session: '$3' } : undefined));

      await expect(service.launch('alex')).resolves.toBe(true);

      const newWindow = run.mock.calls.find(call => call[1].includes('new-window'));
      expect(newWindow?.[1]).toEqual(expect.arrayContaining(['-S', '/host-tmux/default', 'new-window', '-d', '-t', '$3']));
      expect(run.mock.calls.some(call => call[1].includes('new-session') || call[1].includes('rename-session'))).toBe(false);
    });

    it('never adopts a pane the operator currently has open as a Terminal', async () => {
      process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const worktree = alex();
      // an ordinary idle shell that would normally be adopted, but a browser has it open
      const panes = { listPanes: async () => [shellPane({}, socket)], pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true) };
      const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree], () => new Set(['sock\0%1']));

      await expect(service.launch('alex')).resolves.toBe(true);

      expect(panes.pastePrompt).not.toHaveBeenCalled();
    });

    it("killWorktreeShells leaves a Console shell and an open Terminal alone, killing only an idle landing shell", async () => {
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const worktree = alex();
      const closed: string[] = [];
      const panes = {
        listPanes: async () => [
          shellPane({ paneId: '%1', role: 'shell' }, socket),
          shellPane({ paneId: '%2' }, socket),
          shellPane({ paneId: '%3' }, socket)
        ],
        close: async (_socket: SocketRef, pane: string) => { closed.push(pane); return true; }
      };
      const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree], () => new Set(['sock\0%3']));

      await service.killWorktreeShells(worktree);

      // %1 is marked, %3 is open as a Terminal; only the bare idle landing shell %2 is killed
      expect(closed).toEqual(['%2']);
    });

    it('placeConsoleShells returns only this Worktree\'s marked shells', async () => {
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const worktree = alex();
      const panes = { listPanes: async () => [
        shellPane({ paneId: '%1', role: 'shell', paneName: 'build' }, socket),
        shellPane({ paneId: '%2' }, socket),                                   // unmarked landing shell
        shellPane({ paneId: '%3', role: 'shell', path: '/home/ubuntu/other' }, socket) // another worktree
      ] };
      const service = new LaunchService(codex, { find: async () => [socket] }, panes as never, undefined, undefined, () => [worktree]);

      const shells = await service.placeConsoleShells(worktree);
      expect(shells.map(shell => shell.paneId)).toEqual(['%1']);
      expect(service.consoleShellBusy(shells[0]!)).toBe(false);
    });

    describe('Place membership', () => {
      const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
      const notes = { id: 'notes', label: 'Notes', path: '/data/notes', identity: '/data/notes', mode: 'directory', hostPath: '/host/notes', worktreesDirectory: '/data/notes-worktrees', available: true, push: { label: 'p', prompt: '$p' } };
      const config = { ...(codex as object), projects: [notes], scratchDirectory: '/home/me/scratch' } as never;
      // non-git fake paths are their own roots, as a real `git rev-parse` failure resolves them
      const service = (panes: Array<Record<string, unknown>>, worktrees: Worktree[] = [alex()]) => new LaunchService(config, { find: async () => [socket] }, { listPanes: async () => panes.map(pane => ({ sessionId: '$1', pid: 1, command: 'zsh', title: '', socket, ...pane })) } as never, async path => path, undefined, () => worktrees);

      it("counts a directory Project's Console shells in its folder, its subfolders and its bridge host path", async () => {
        const shells = await service([
          { paneId: '%1', role: 'shell', path: '/data/notes' },
          { paneId: '%2', role: 'shell', path: '/data/notes/2026/september' },
          { paneId: '%3', role: 'shell', path: '/host/notes/drafts' },
          { paneId: '%4', role: 'shell', path: '/data/notes-archive' },
          { paneId: '%5', path: '/data/notes' }
        ]).placeConsoleShells({ id: 'notes:/data/notes' });

        expect(shells.map(shell => shell.paneId)).toEqual(['%1', '%2', '%3']);
      });

      it('counts the Scratch folder\'s Console shells and gives an unconfigured folder its own Scratch Place', async () => {
        const launch = service([
          { paneId: '%1', role: 'shell', path: '/home/me/scratch/probe' },
          { paneId: '%2', role: 'shell', path: '/srv/tools' },
          { paneId: '%3', role: 'shell', path: '/srv/tools/bin' }
        ]);

        expect((await launch.placeConsoleShells({ id: 'scratch:/home/me/scratch' })).map(shell => shell.paneId)).toEqual(['%1']);
        expect((await launch.placeConsoleShells({ id: 'scratch:/srv/tools' })).map(shell => shell.paneId)).toEqual(['%2']);
        // an unconfigured folder contains nothing: a non-git subfolder is a Scratch Place of its own
        expect((await launch.placeConsoleShells({ id: 'scratch:/srv/tools/bin' })).map(shell => shell.paneId)).toEqual(['%3']);
      });

      it('counts a Console shell in a nested, unconfigured checkout for the Worktree around it, but not one in a nested Worktree', async () => {
        const nested = cora({ id: 'alex-agent', label: 'Alex · agent', path: '/worktrees/alex/.claude/worktrees/3', identity: '/worktrees/alex/.claude/worktrees/3', hostPath: undefined });
        const launch = service([
          { paneId: '%1', role: 'shell', path: '/home/ubuntu/alex/vendor/lib' },
          { paneId: '%2', role: 'shell', path: '/worktrees/alex/.claude/worktrees/3' }
        ], [alex(), nested]);

        expect((await launch.placeConsoleShells({ id: 'alex' })).map(shell => shell.paneId)).toEqual(['%1']);
        expect((await launch.placeConsoleShells({ id: 'alex-agent' })).map(shell => shell.paneId)).toEqual(['%2']);
      });

      it('never streams a nested Worktree\'s session for the Worktree around it', async () => {
        const nested = cora({ id: 'alex-agent', label: 'Alex · agent', path: '/worktrees/alex/.claude/worktrees/3', identity: '/worktrees/alex/.claude/worktrees/3', hostPath: undefined });
        const launch = service([
          { paneId: '%1', sessionId: '$1', path: '/worktrees/alex/vendor/lib' },
          { paneId: '%2', sessionId: '$2', path: '/worktrees/alex/.claude/worktrees/3/src' }
        ], [alex(), nested]);

        expect((await launch.placePanes({ id: 'alex' })).map(pane => pane.paneId)).toEqual(['%1']);
        expect((await launch.placePanes({ id: 'alex-agent' })).map(pane => pane.paneId)).toEqual(['%2']);
      });

      it("opens a directory Project's first Console shell in its bridge host path, in a session named for it", async () => {
        process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
        run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? '%5' : '', stderr: '' }));
        const launch = service([]);

        await expect(launch.createConsoleShell({ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', home: '/data/notes', hostPath: '/host/notes' }, 'build')).resolves.toBe('%5');

        const newSession = run.mock.calls.find(call => call[1].includes('new-session'));
        expect(newSession?.[1]).toEqual(expect.arrayContaining(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'notes', '-c', '/host/notes']));
        expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%5', '@rac_pane_name', 'build']);
      });

      it("opens a Scratch Place's Console shell in the session already holding its shells", async () => {
        const createConsoleShellWindow = vi.fn(async () => '%9');
        // another Place's shell comes first, so only the Place filter picks the right session
        const panes = [
          { paneId: '%2', sessionId: '$1', role: 'shell', path: '/data/notes' },
          { paneId: '%1', sessionId: '$4', role: 'shell', path: '/home/me/scratch' }
        ].map(pane => ({ pid: 1, command: 'zsh', title: '', socket, ...pane }));
        const launch = new LaunchService(config, { find: async () => [socket] }, { listPanes: async () => panes, createConsoleShellWindow } as never, async path => path, undefined, () => [alex()]);

        await expect(launch.createConsoleShell({ id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', home: '/home/me/scratch' }, '')).resolves.toBe('%9');

        expect(createConsoleShellWindow).toHaveBeenCalledWith(socket, '$4', '/home/me/scratch', [interactiveShellPath(), '-l'], '');
        expect(run.mock.calls.some(call => call[1].includes('new-session'))).toBe(false);
      });

      it("streams every pane of a session that holds one of a directory Project's panes", async () => {
        const panes = await service([
          { paneId: '%1', sessionId: '$1', path: '/data/notes/2026' },
          { paneId: '%2', sessionId: '$1', path: '/tmp' },
          { paneId: '%3', sessionId: '$2', path: '/srv/tools' }
        ]).placePanes({ id: 'notes:/data/notes' });

        expect(panes.map(pane => pane.paneId)).toEqual(['%1', '%2']);
      });

      it("never streams the console's own stack sessions, though their cwd is at the Place", async () => {
        // the status-probe holder inherits the console's cwd, and a stack operation runs in the Worktree
        const panes = await service([
          { paneId: '%1', sessionId: '$1', path: '/data/notes' },
          { paneId: '%3', sessionId: '$2', sessionName: 'rac-stack-probes', command: 'sh', path: '/data/notes' },
          { paneId: '%4', sessionId: '$3', sessionName: 'rac-stack-notes-start', path: '/data/notes' }
        ]).placePanes({ id: 'notes:/data/notes' });

        expect(panes.map(pane => pane.paneId)).toEqual(['%1']);
      });
    });
  });

  describe('Launching into a directory Project or Scratch joins its Place', () => {
    const socket: SocketRef = { fingerprint: 'sock', path: '/host-tmux/default', device: 1, inode: 2 };
    const notes = { id: 'notes', label: 'Notes', path: '/data/notes', identity: '/data/notes', mode: 'directory', hostPath: '/host/notes', available: true };
    const config = { ...(codex as object), projects: [notes], scratchDirectory: '/home/me/scratch' } as never;
    const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
    const pane = (over: Record<string, unknown>) => ({ paneId: '%1', sessionId: '$1', pid: 1, path: '/host/notes', command: 'zsh', title: '', socket, ...over });
    // non-git fake paths are their own roots, as a real `git rev-parse` failure resolves them
    const service = (panes: Array<Record<string, unknown>>, agentSession: (placeId: string) => Promise<TmuxSession | undefined> = async () => undefined, extra: Record<string, unknown> = {}, placeConfig = config) =>
      new LaunchService(placeConfig, { find: async () => [socket] }, { listPanes: async () => panes.map(pane), pastePrompt: vi.fn(async () => true), enter: vi.fn(async () => true), ...extra } as never, async path => path, store as never, () => [], () => new Set(), agentSession);
    const tmuxCall = (verb: string) => run.mock.calls.find(call => (call[1] as string[]).includes(verb))?.[1] as string[] | undefined;
    beforeEach(() => { process.env.RAC_HOST_TMUX_DIR = '/host-tmux'; });

    it("adopts the Place's idle console-launched shell, never a Console shell, a stranger's shell, a subfolder or another label", async () => {
      const pastePrompt = vi.fn(async () => true);
      const launch = service([
        { paneId: '%1', role: 'shell', consoleManaged: true, displayLabel: 'Notes' }, // a Console shell
        { paneId: '%2' },                                                            // the operator's own shell
        { paneId: '%6', consoleManaged: true },                                      // the operator's shell a Worktree launch once adopted
        { paneId: '%3', path: '/host/notes/drafts', consoleManaged: true, displayLabel: 'Notes' }, // a subfolder
        { paneId: '%4', consoleManaged: true, displayLabel: 'Update Advisor' },     // another launch's label
        { paneId: '%7', command: 'codex', consoleManaged: true, displayLabel: 'Notes' }, // a running Agent
        { paneId: '%5', consoleManaged: true, displayLabel: 'Notes' }               // the Project's last Agent, exited
      ], undefined, { pastePrompt });

      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(true);

      expect(pastePrompt).toHaveBeenCalledTimes(1);
      expect(pastePrompt).toHaveBeenCalledWith(socket, '%5', expect.stringMatching(/^rac-launch-/u), codexProgram);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%5', '@rac_display_label', 'Notes']);
      expect(tmuxCall('new-session')).toBeUndefined();
      expect(tmuxCall('new-window')).toBeUndefined();
    });

    it('adopts at the Place home itself for a Scratch Place and an unbridged directory Project', async () => {
      const pastePrompt = vi.fn(async (_socket: SocketRef, _pane: string, _buffer: string, _text: string) => true);
      const local = { ...(config as object), projects: [{ ...notes, hostPath: undefined }] } as never;
      const launch = service([
        { paneId: '%1', path: '/data/notes', consoleManaged: true, displayLabel: 'Notes' },
        { paneId: '%2', path: '/home/me/scratch', consoleManaged: true, displayLabel: scratchLabel }
      ], undefined, { pastePrompt }, local);

      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(true);
      await expect(launch.launchHome()).resolves.toBe(true);

      expect(pastePrompt.mock.calls.map(call => call[1])).toEqual(['%1', '%2']);
      expect(tmuxCall('new-session')).toBeUndefined();
    });

    it("opens a Scratch launch as a window in the session holding the Scratch folder's Console shells", async () => {
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      // another Place's shell comes first, and a stranger's shell sits in the Scratch folder
      const launch = service([
        { paneId: '%2', sessionId: '$1', role: 'shell' },
        { paneId: '%1', sessionId: '$4', role: 'shell', path: '/home/me/scratch/probe' },
        { paneId: '%6', sessionId: '$5', path: '/home/me/scratch' }
      ]);

      await expect(launch.launchHome()).resolves.toBe(true);

      expect(tmuxCall('new-window')?.slice(0, 8)).toEqual(['-S', '/host-tmux/default', 'new-window', '-d', '-t', '$4', '-c', '/home/me/scratch']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%9', '@rac_display_label', scratchLabel]);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%9', '@rac_console_managed', '1']);
      expect(tmuxCall('new-session')).toBeUndefined();
    });

    it("opens a directory-Project launch as a window in its live Agent's session when it has no Console shells", async () => {
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const agentSocket: SocketRef = { fingerprint: 'mine', path: '/run/user/1000/tmux/default', device: 3, inode: 4 };
      const asked: string[] = [];
      const launch = service([{ paneId: '%3', sessionId: '$2', role: 'shell', path: '/home/me/scratch' }], async placeId => { asked.push(placeId); return placeId === 'notes:/data/notes' ? { socket: agentSocket, session: '$7' } : undefined; });

      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(true);

      expect(asked).toEqual(['notes:/data/notes']);
      const window = tmuxCall('new-window');
      expect(window?.slice(0, 8)).toEqual(['-S', '/run/user/1000/tmux/default', 'new-window', '-d', '-t', '$7', '-c', '/host/notes']);
      // the host bootstrap exports the account home, as a fresh directory launch does
      expect(window?.join(' ')).toContain("export HOME='/host'");
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/run/user/1000/tmux/default', 'set-option', '-p', '-t', '%9', '@rac_display_label', 'Notes']);
    });

    it('starts a session named for the Place when it has nothing to adopt or join', async () => {
      let panes = 0;
      run.mockImplementation(async (_bin: string, args: string[]) => ({ code: 0, stdout: args.includes('new-session') ? `%${++panes}` : '', stderr: '' }));
      const launch = service([]);

      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(true);
      await expect(launch.launchHome()).resolves.toBe(true);

      const sessions = run.mock.calls.filter(call => (call[1] as string[]).includes('new-session')).map(call => (call[1] as string[]).slice(0, 8));
      expect(sessions).toEqual([
        ['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'notes', '-c', '/host/notes'],
        ['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'scratch', '-c', '/home/me/scratch']
      ]);
      // options target the new pane, never the bare session name (which can resolve to a window elsewhere)
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%1', '@rac_display_label', 'Notes']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%1', '@rac_console_managed', '1']);
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/host-tmux/default', 'set-option', '-p', '-t', '%2', '@rac_display_label', scratchLabel]);
    });

    it('writes a dotted Place folder as tmux will list its session, so the free-name check sees it', async () => {
      run.mockImplementation(async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('list-sessions') ? 'example_com\n' : args.includes('new-session') ? '%5' : '', stderr: '' }));
      const dotted = { ...(config as object), projects: [{ ...notes, hostPath: '/srv/example.com' }] } as never;

      await expect(service([], undefined, {}, dotted).launchProjectDirectory('notes')).resolves.toBe(true);

      expect(tmuxCall('new-session')?.slice(0, 6)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'example_com-2']);
    });

    it('suffixes the Place session past a name another session already holds', async () => {
      run.mockImplementation(async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('list-sessions') ? 'notes\n' : args.includes('new-session') ? '%5' : '', stderr: '' }));

      await expect(service([]).launchProjectDirectory('notes')).resolves.toBe(true);

      expect(tmuxCall('new-session')?.slice(0, 6)).toEqual(['-S', '/host-tmux/default', 'new-session', '-d', '-s', 'notes-2']);
    });

    it('launches a local Place window through the runner, keeping the command out of the process table', async () => {
      delete process.env.RAC_HOST_TMUX_DIR;
      const root = await mkdtemp(join(tmpdir(), 'rac-launch-'));
      tempDirs.push(root);
      run.mockResolvedValue({ code: 0, stdout: '%9', stderr: '' });
      const local: SocketRef = { fingerprint: 'mine', path: '/tmp/tmux-1000/default', device: 3, inode: 4 };
      const launch = new LaunchService(config, { find: async () => [] }, { listPanes: async () => [] } as never, async path => path, store as never, () => [], () => new Set(), async () => ({ socket: local, session: '$7' }), root);

      await expect(launch.launchHome()).resolves.toBe(true);

      expect(tmuxCall('new-window')?.slice(0, 10)).toEqual(['-S', '/tmp/tmux-1000/default', 'new-window', '-d', '-t', '$7', '-P', '-F', '#{pane_id}', process.execPath]);
      expect(tmuxCall('new-window')?.join(' ')).not.toContain(codexProgram);
    });

    it('refuses a second launch into the same Place while the first is in flight, but not one into another Place', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let lists = 0;
      const launch = new LaunchService(config, { find: async () => [socket] }, { listPanes: async () => { lists += 1; if (lists === 1) await gate; return []; } } as never, async path => path, store as never, () => []);

      const first = launch.launchProjectDirectory('notes');
      await vi.waitFor(() => expect(lists).toBe(1));
      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(false);
      await expect(launch.launchHome()).resolves.toBe(true);
      run.mockResolvedValue({ code: 0, stdout: '%5', stderr: '' });
      release();
      await expect(first).resolves.toBe(true);
      // the Place is free again once its launch settles
      await expect(launch.launchProjectDirectory('notes')).resolves.toBe(true);
    });

    it('resolves the Place each in-place launch joins', async () => {
      const launch = service([]);

      await expect(launch.directoryPlace('notes')).resolves.toMatchObject({ id: 'notes:/data/notes', kind: 'directory', label: 'Notes' });
      await expect(launch.directoryPlace('absent')).resolves.toBeUndefined();
      // a repository Project launches through its Worktrees, an unavailable one has nothing to join
      const refused = service([], undefined, {}, { ...(config as object), projects: [{ ...notes, mode: 'repository' }, { ...notes, id: 'gone', available: false }] } as never);
      await expect(refused.directoryPlace('notes')).resolves.toBeUndefined();
      await expect(refused.directoryPlace('gone')).resolves.toBeUndefined();
      await expect(launch.scratchPlace()).resolves.toMatchObject({ id: 'scratch:/home/me/scratch', kind: 'scratch', label: scratchLabel });
    });
  });
});
