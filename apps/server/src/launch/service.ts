import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { expandLaunch } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellName, interactiveShellPath } from '../tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../tmux/session-name.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import type { Pane, SocketRef, Worktree } from '../domain/models.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';

export function expandCommand(command: string, worktree: Pick<Worktree, 'identity'>): string {
  const directory = `'${worktree.identity.replaceAll("'", "'\\''")}'`;
  const script = `'${command.replaceAll("'", "'\\''")}'`;
  return `cd -- ${directory} && eval ${script}`;
}

export function expandHomeCommand(command: string, home: string): string {
  return expandCommand(command, { identity: home });
}

export const scratchLabel = '~ Scratch';
// allow approved host repairs and verification
const updateAdvisorCommand = 'command codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen';

export class LaunchService {
  private pending = new Set<string>(); private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`; private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly localShell = interactiveShellPath();
  private readonly hostShell = hostInteractiveShellPath();
  private readonly hostShellName = interactiveShellName(this.hostShell);
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter()) {}
  // resolve the authenticated account home independently from the launch directory
  private agentHome(): string {
    const hostPath = this.config.worktrees.find(worktree => worktree.hostPath !== undefined)?.hostPath;
    return hostPath === undefined ? process.env.HOME ?? '/' : dirname(hostPath);
  }
  private async existingPane(worktree: Worktree): Promise<{ socket: SocketRef; pane: Pane } | undefined> {
    const roots = [worktree.hostPath, worktree.identity].filter((path): path is string => path !== undefined);
    for (const socket of await this.finder.find()) for (const pane of await this.panes.listPanes(socket)) {
      if (!roots.some(root => pane.path === root || pane.path.startsWith(`${root}/`))) continue;
      if (pane.sessionName?.startsWith('rac-stack-')) continue;
      if (pane.command !== this.hostShellName) continue;
      return { socket, pane };
    }
    return undefined;
  }
  private async labelScratchSession(session: string, label = scratchLabel): Promise<boolean> {
    const socket = this.hostSocket === undefined ? [] : ['-S', this.hostSocket];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', session, '@rac_display_label', label])).code === 0;
  }
  // launch one ordinary home scratch agent
  async launchHome(): Promise<boolean> {
    const home = this.agentHome();
    return await this.launchScratch(home, scratchLabel);
  }

  // launch one dedicated advisor in a fixed server-owned checkout
  async launchUpdateAdvisor(repository: string, targetSha: string): Promise<boolean> {
    // reject malformed internal paths
    if (!repository.startsWith('/') || repository.includes('\0') || !/^[0-9a-f]{40}$/u.test(targetSha)) return false;
    return await this.launchScratch(repository, updateAdvisorPendingLabel(targetSha), updateAdvisorCommand, this.agentHome());
  }

  // launch one uniquely labeled scratch session
  private async launchScratch(directory: string, label: string, agentCommand = this.config.newAgentCommand, home = directory): Promise<boolean> {
    const key = `scratch:${directory}:${label}`;
    // serialize matching scratch launches
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const id = randomBytes(18).toString('base64url');
      const session = `rac-${id.slice(0, 12)}`;
      const command = expandHomeCommand(agentCommand, directory);
      // launch through the host bridge when configured
      if (this.hostSocket !== undefined) {
        if ((await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', session, '-c', directory, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand(command, home), home, this.hostShell)])).code !== 0) return false;
        return await this.labelScratchSession(session, label);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const handle = await open(descriptor, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ program: this.localShell, args: ['-lc', interactiveShellBootstrap(command, home, this.localShell)], cwd: directory }));
      await handle.close();
      const runner = new URL('./runner.js', import.meta.url).pathname;
      const created = await run(this.tmux, ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]);
      // clean failed launch descriptors
      if (created.code !== 0) { await unlink(descriptor).catch(() => {}); return false; }
      return await this.labelScratchSession(session, label);
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

  // resume one exact bookmarked Codex conversation
  async resumeConversation(worktreeId: string, threadId: string): Promise<boolean> {
    // keep the host command free of shell input
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)) return false;
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    // require one explicit exact-resume capability
    if (worktree?.resumeCommand === undefined) return false;
    const command = worktree.resumeCommand.replace('{threadId}', threadId);
    return await this.launchWorktree(worktreeId, command);
  }

  // expose exact-resume support before destructive lifecycle work
  canResumeConversation(worktreeId: string): boolean {
    return this.config.worktrees.some(worktree => worktree.id === worktreeId && worktree.resumeCommand !== undefined);
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
        const tail = ['-c', hostWorktree.identity, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand(expandCommand(command, hostWorktree), home), home, this.hostShell)];
        return await startNamedReplacementSession(this.tmux, this.hostSocket, session, session, tail);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const payload = command === undefined
        ? { program: worktree.launch!.program, args: expandLaunch(worktree.launch!, worktree), cwd: worktree.identity }
        : { program: this.localShell, args: ['-lc', interactiveShellBootstrap(expandCommand(command, worktree), '$HOME', this.localShell)], cwd: worktree.identity };
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
