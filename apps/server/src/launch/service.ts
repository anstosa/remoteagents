import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { expandLaunch } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { hostInteractiveShell, interactiveShell, interactiveShellBootstrap } from '../tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../tmux/session-name.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import type { Pane, SocketRef, Worktree } from '../domain/models.js';

export function expandCommand(command: string, worktree: Pick<Worktree, 'identity'>): string {
  const directory = `'${worktree.identity.replaceAll("'", "'\\''")}'`;
  const script = `'${command.replaceAll("'", "'\\''")}'`;
  return `cd -- ${directory} && eval ${script}`;
}

export function expandHomeCommand(command: string, home: string): string {
  return expandCommand(command, { identity: home });
}

export function hostCommand(command: string, home: string): string {
  const directory = `'${home.replaceAll("'", "'\\''")}'`;
  return `export HOME=${directory}\nexport PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"\n${command}`;
}

export const scratchLabel = '~ Scratch';

export class LaunchService {
  private pending = new Set<string>(); private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`; private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter()) {}
  private async existingPane(worktree: Worktree): Promise<{ socket: SocketRef; pane: Pane } | undefined> {
    const roots = [worktree.hostPath, worktree.identity].filter((path): path is string => path !== undefined);
    for (const socket of await this.finder.find()) for (const pane of await this.panes.listPanes(socket)) {
      if (!roots.some(root => pane.path === root || pane.path.startsWith(`${root}/`))) continue;
      if (pane.sessionName?.startsWith('rac-stack-')) continue;
      if (pane.command !== 'zsh') continue;
      return { socket, pane };
    }
    return undefined;
  }
  private async labelScratchSession(session: string): Promise<boolean> {
    const socket = this.hostSocket === undefined ? [] : ['-S', this.hostSocket];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', session, '@rac_display_label', scratchLabel])).code === 0;
  }
  async launchHome(): Promise<boolean> {
    const key = 'home';
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const id = randomBytes(18).toString('base64url');
      const session = `rac-${id.slice(0, 12)}`;
      const hostPath = this.config.worktrees.find(worktree => worktree.hostPath !== undefined)?.hostPath;
      const home = hostPath === undefined ? process.env.HOME ?? '/' : dirname(hostPath);
      const command = expandHomeCommand(this.config.newAgentCommand, home);
      if (this.hostSocket !== undefined) {
        if ((await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', session, '-c', home, hostInteractiveShell, '-lc', interactiveShellBootstrap(hostCommand(command, home), home, hostInteractiveShell)])).code !== 0) return false;
        return await this.labelScratchSession(session);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const handle = await open(descriptor, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ program: interactiveShell, args: ['-lc', interactiveShellBootstrap(command)], cwd: home }));
      await handle.close();
      const runner = new URL('./runner.js', import.meta.url).pathname;
      const created = await run(this.tmux, ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]);
      if (created.code !== 0) { await unlink(descriptor).catch(() => {}); return false; }
      return await this.labelScratchSession(session);
    } finally { this.pending.delete(key); }
  }

  // launch the configured worktree command
  async launch(worktreeId: string): Promise<boolean> {
    return await this.launchWorktree(worktreeId);
  }

  // resume the previous Codex conversation through the host alias
  async resume(worktreeId: string): Promise<boolean> {
    return await this.launchWorktree(worktreeId, 'resume');
  }

  // start one worktree with its configured or requested command
  private async launchWorktree(worktreeId: string, requestedCommand?: string): Promise<boolean> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    // serialize each worktree launch
    if (!worktree || this.pending.has(worktreeId)) return false;
    this.pending.add(worktreeId);
    try {
      const id = randomBytes(18).toString('base64url');
      const command = requestedCommand ?? worktree.command;
      // reuse an existing interactive shell
      if (command !== undefined) {
        const existing = await this.existingPane(worktree);
        // send through the shell alias context
        if (existing !== undefined) {
          const buffer = `rac-launch-${id}`;
          return await this.panes.pastePrompt(existing.socket, existing.pane.paneId, buffer, command)
            && await this.panes.enter(existing.socket, existing.pane.paneId);
        }
      }
      const session = worktreeSessionName(worktree.hostPath ?? worktree.identity);
      // launch host-mounted worktrees on the host socket
      if (this.hostSocket !== undefined && command !== undefined) {
        const hostWorktree = { ...worktree, identity: worktree.hostPath ?? worktree.identity };
        const home = dirname(hostWorktree.identity);
        const tail = ['-c', hostWorktree.identity, hostInteractiveShell, '-lc', interactiveShellBootstrap(hostCommand(expandCommand(command, hostWorktree), home), home, hostInteractiveShell)];
        return await startNamedReplacementSession(this.tmux, this.hostSocket, session, session, tail);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const payload = command === undefined
        ? { program: worktree.launch!.program, args: expandLaunch(worktree.launch!, worktree), cwd: worktree.identity }
        : { program: interactiveShell, args: ['-lc', interactiveShellBootstrap(expandCommand(command, worktree))], cwd: worktree.identity };
      const handle = await open(descriptor, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(payload));
      await handle.close();
      const runner = new URL('./runner.js', import.meta.url).pathname;
      const created = await run(this.tmux, ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]);
      // remove rejected launch descriptors
      if (created.code !== 0) {
        await unlink(descriptor).catch(() => {});
        return false;
      }
      return true;
    } finally {
      this.pending.delete(worktreeId);
    }
  }
}
