import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellName, interactiveShellPath } from '../tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../tmux/session-name.js';
import { ProcSocketFinder, workspaceRoot, type SocketFinder } from '../discovery/service.js';
import { worktreeHostRoot, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { adapterFor } from '../adapters/registry.js';
import type { LaunchMode } from '../adapters/types.js';
import type { Pane, SocketRef, Worktree } from '../domain/models.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';

export function expandCommand(command: string, worktree: Pick<Worktree, 'identity'>): string {
  const directory = `'${worktree.identity.replaceAll("'", "'\\''")}'`;
  const script = `'${command.replaceAll("'", "'\\''")}'`;
  return `cd -- ${directory} && eval ${script}`;
}

// shell-quote an argument only when it holds a character the shell would act on;
// the Adapter's plain flags (`resume`, `--last`) and validated ids stay legible.
const shellQuote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

// Compose the inner shell command the console runs: the configured program
// string followed by the Adapter's mode arguments. Fresh launches append
// nothing, so the operator's `command` runs exactly as before.
export function composeCommand(program: string, args: string[]): string {
  return args.length === 0 ? program : `${program} ${args.map(shellQuote).join(' ')}`;
}

// Resolve the shell command for a worktree launch through its Adapter: an
// explicit `resumeCommand` template is honoured as an operator override for exact
// resume, otherwise the console prepends the configured program to the Adapter's
// args. Chunk 1 resolves every launch to Codex; later chunks resolve by kind.
function worktreeLaunchCommand(worktree: Worktree, input: LaunchRequest): string | undefined {
  if (input.mode === 'resume' && input.conversationId !== undefined && worktree.resumeCommand !== undefined) {
    return worktree.resumeCommand.replace('{threadId}', input.conversationId);
  }
  if (worktree.command === undefined) return undefined;
  const spec = adapterFor('codex')?.launch({ mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), cwd: worktree.identity, sandboxed: input.sandboxed }) ?? { args: [] };
  return composeCommand(worktree.command, spec.args);
}

// one worktree launch request: which conversation (if any) and whether to confine it
type LaunchRequest = { mode: LaunchMode; conversationId?: string; sandboxed: boolean };

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
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter(), private readonly paneRoot: (path: string) => Promise<string> = workspaceRoot) {}
  // resolve the authenticated account home independently from the launch directory
  agentHome(): string {
    const hostPath = this.config.worktrees.find(worktree => worktree.hostPath !== undefined)?.hostPath;
    return hostPath === undefined ? process.env.HOME ?? '/' : dirname(hostPath);
  }
  private async existingPane(worktree: Worktree): Promise<{ socket: SocketRef; pane: Pane } | undefined> {
    const sockets = await this.finder.find();
    // list every socket concurrently; the first match in discovery order still wins
    const listed = await Promise.all(sockets.map(async socket => ({ socket, panes: await this.panes.listPanes(socket) })));
    for (const { socket, panes } of listed) for (const pane of panes) {
      if (pane.sessionName?.startsWith('rac-stack-')) continue;
      if (pane.command !== this.hostShellName) continue;
      // reuse a shell only when its git toplevel is exactly this worktree, never a
      // parent whose subtree holds a nested checkout (a `.claude/worktrees/<n>` the
      // agent's own tool created); a subdirectory of the worktree still resolves here.
      if (!await this.paneBelongsTo(worktree, pane.path)) continue;
      return { socket, pane };
    }
    return undefined;
  }

  // does a shell's working directory belong to this worktree by exact git toplevel?
  private async paneBelongsTo(worktree: Worktree, paneCwd: string): Promise<boolean> {
    // a shell already at the worktree root needs no git resolution
    if (worktreeMatchesWorkspace(worktree, paneCwd)) return true;
    return worktreeMatchesWorkspace(worktree, await this.paneRoot(paneCwd));
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
    if (!repository.startsWith('/') || repository.includes('\0') || !isFullGitSha(targetSha)) return false;
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
    return await this.launchWorktree(worktreeId, { mode: 'fresh' });
  }

  // resume the previous conversation (Codex: `codex resume --last`), no shell alias
  async resume(worktreeId: string): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'continue' });
  }

  // resume one exact bookmarked conversation by its id
  async resumeConversation(worktreeId: string, threadId: string): Promise<boolean> {
    // keep the host command free of shell input, whether the id is quoted or substituted
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)) return false;
    return await this.launchWorktree(worktreeId, { mode: 'resume', conversationId: threadId });
  }

  // expose exact-resume support before destructive lifecycle work: any launchable
  // worktree resumes through its Adapter; an explicit template only overrides how
  canResumeConversation(worktreeId: string): boolean {
    return this.config.worktrees.some(worktree => worktree.id === worktreeId && (worktree.command !== undefined || worktree.resumeCommand !== undefined));
  }

  // start one worktree in the requested mode, composing its command from the Adapter
  private async launchWorktree(worktreeId: string, input: { mode: LaunchMode; conversationId?: string; sandboxed?: boolean }): Promise<boolean> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    // serialize each worktree launch
    if (!worktree || this.pending.has(worktreeId)) return false;
    this.pending.add(worktreeId);
    try {
      const id = randomBytes(18).toString('base64url');
      const sandboxed = input.sandboxed === true;
      const command = worktreeLaunchCommand(worktree, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), sandboxed });
      // a worktree with no launch command (and no override) cannot start
      if (command === undefined) return false;
      // reuse an existing interactive shell
      const existing = await this.existingPane(worktree);
      // send through the shell context
      if (existing !== undefined) {
        const buffer = `rac-launch-${id}`;
        return await this.panes.pastePrompt(existing.socket, existing.pane.paneId, buffer, command)
          && await this.panes.enter(existing.socket, existing.pane.paneId)
          && await this.markSandboxed(existing.socket.path, existing.pane.paneId, sandboxed);
      }
      const session = worktreeSessionName(worktreeHostRoot(worktree));
      // launch host-mounted worktrees on the host socket
      if (this.hostSocket !== undefined) {
        const hostWorktree = { ...worktree, identity: worktreeHostRoot(worktree) };
        const home = dirname(hostWorktree.identity);
        const tail = ['-c', hostWorktree.identity, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand(expandCommand(command, hostWorktree), home), home, this.hostShell)];
        return await startNamedReplacementSession(this.tmux, this.hostSocket, session, session, tail)
          && await this.markSandboxed(this.hostSocket, session, sandboxed);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const payload = { program: this.localShell, args: ['-lc', interactiveShellBootstrap(expandCommand(command, worktree), '$HOME', this.localShell)], cwd: worktree.identity };
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
      return await this.markSandboxed(undefined, session, sandboxed);
    } finally {
      this.pending.delete(worktreeId);
    }
  }

  // record a Sandboxed launch on the pane so `Agent.sandboxed` reflects it; a
  // dead pane's option is cleared by discovery. Chunk 1 never launches sandboxed
  // (chunk 4 realises the sandbox), so in practice this is a no-op until then.
  private async markSandboxed(socketPath: string | undefined, target: string, sandboxed: boolean): Promise<boolean> {
    if (!sandboxed) return true;
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_sandboxed', '1'])).code === 0;
  }
}
