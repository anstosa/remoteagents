import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveCodexProgram, type ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellName, interactiveShellPath } from '../tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../tmux/session-name.js';
import { ProcSocketFinder, workspaceRoot, type SocketFinder } from '../discovery/service.js';
import { projectIdOf, worktreeHostRoot, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { adapterCapabilities, adapterFor } from '../adapters/registry.js';
import { renderAdapterFiles, type RenderedAdapterFiles } from '../adapters/files.js';
import { agentKinds, type AgentKind, type LaunchInput, type LaunchMode } from '../adapters/types.js';
import { resolveLaunchProfile, type LaunchResolution, type LaunchScope } from './resolution.js';
import { WorktreeLaunchStore, scratchLaunchKey } from '../worktrees/store.js';
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

// Compose a configured Adapter launch: [program, …adapter args, …operator args]
// with the Adapter's environment overlaid by the operator's, rendered as a
// shell-quoted assignment prefix. Everything is quoted, so nothing expands.
export function composeLaunch(program: string, adapterArgs: string[], operatorArgs: string[], adapterEnv: Record<string, string> = {}, operatorEnv: Record<string, string> = {}): string {
  const env = { ...adapterEnv, ...operatorEnv };
  const prefix = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ');
  const command = composeCommand(shellQuote(program), [...adapterArgs, ...operatorArgs]);
  return prefix === '' ? command : `${prefix} ${command}`;
}

// one worktree launch request: which conversation (if any) and whether to confine it
type LaunchRequest = { mode: LaunchMode; conversationId?: string; sandboxed: boolean };

export function expandHomeCommand(command: string, home: string): string {
  return expandCommand(command, { identity: home });
}

export const scratchLabel = '~ Scratch';
// allow approved host repairs and verification
const updateAdvisorArgs = ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];

export class LaunchService {
  private pending = new Set<string>(); private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`; private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly localShell = interactiveShellPath();
  private readonly hostShell = hostInteractiveShellPath();
  private readonly hostShellName = interactiveShellName(this.hostShell);
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter(), private readonly paneRoot: (path: string) => Promise<string> = workspaceRoot, private readonly worktreeStore: WorktreeLaunchStore = new WorktreeLaunchStore(), private readonly discoveredWorktrees: () => Worktree[] = () => []) {}

  // one discovered Worktree by its wire id `<projectId>:<realpath>`
  private worktreeById(worktreeId: string): Worktree | undefined {
    return this.discoveredWorktrees().find(candidate => candidate.id === worktreeId);
  }

  // the Codex binary the update advisor spawns (RAC_CODEX_BIN, else adapters.codex.program)
  codexProgram(): string | undefined {
    return resolveCodexProgram(this.config);
  }

  private adapterFilesPromise: Promise<RenderedAdapterFiles> | undefined;
  // This kind's rendered console-owned files for `LaunchInput.files`, or `undefined`
  // when the kind declares none (Codex, and every legacy launch) — which keeps the
  // launch hot path off the filesystem. Only a *successful* render is memoized; a
  // transient failure is logged, degrades this launch to no files (it omits
  // `--settings`) rather than failing, and clears the memo so the next launch retries.
  private async adapterFiles(kind: AgentKind): Promise<Record<string, string> | undefined> {
    if (adapterFor(kind)?.files === undefined) return undefined;
    this.adapterFilesPromise ??= renderAdapterFiles().catch(error => {
      this.adapterFilesPromise = undefined;
      console.error('[launch] adapter files not rendered:', error instanceof Error ? error.message : 'unknown error');
      return {} as RenderedAdapterFiles;
    });
    return (await this.adapterFilesPromise)[kind];
  }

  // the launchable kinds in registry (resolution) order for the current configuration
  private launchableKinds(): AgentKind[] {
    // the legacy configuration launches only Codex, through the per-worktree command
    if (this.config.adapters === undefined) return ['codex'];
    return agentKinds.filter(kind => (this.config.adapters?.[kind]?.launchable ?? false) && adapterFor(kind) !== undefined);
  }

  // resolve which kind a launch uses: an explicit request must be launchable; otherwise
  // the same precedence the dashboard displays, so the launched kind never diverges from
  // the one the Launch button named (an unreadable store falls back to the first launchable)
  async resolveLaunchKind(scopeKey: string, requested?: AgentKind): Promise<AgentKind | undefined> {
    const kinds = this.launchableKinds();
    if (kinds.length === 0) return undefined;
    if (requested !== undefined) return kinds.includes(requested) ? requested : undefined;
    // a single launchable kind is always the answer; skip the store read on the hot path
    if (kinds.length === 1) return kinds[0];
    const remembered = await this.worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    return resolveLaunchProfile(kinds, this.rememberedChain(scopeKey, remembered), adapterCapabilities(this.config.adapters)).kind;
  }

  // the remembered-kind precedence for one scope: a Worktree's own last-used kind, then
  // its Project's (which seeds a fresh Worktree), then registry order; Scratch stands alone
  private rememberedChain(key: string, remembered: Record<string, AgentKind | undefined>): Array<{ origin: LaunchScope; kind?: AgentKind }> {
    if (key === scratchLaunchKey) return [{ origin: 'scratch', kind: remembered[key] }];
    const projectId = projectIdOf(key);
    // a bare `<projectId>` key resolves in the project scope; a worktree key falls back to it
    if (projectId === key) return [{ origin: 'project', kind: remembered[key] }];
    return [{ origin: 'worktree', kind: remembered[key] }, { origin: 'project', kind: remembered[projectId] }];
  }

  // The Launch profile resolution the dashboard publishes for each scope so the web
  // renders the Launch menu without re-deriving it. Reads the whole launch-profile
  // store once; `scratchLaunchKey` resolves in the scratch scope, every other key in
  // the worktree scope (chunk 3 adds the project scope). Missing scopes are omitted.
  async launchResolutions(scopeKeys: Iterable<string>): Promise<Map<string, LaunchResolution>> {
    const launchable = this.launchableKinds();
    const capabilities = adapterCapabilities(this.config.adapters);
    const remembered = await this.worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    const resolutions = new Map<string, LaunchResolution>();
    for (const key of new Set(scopeKeys)) resolutions.set(key, resolveLaunchProfile(launchable, this.rememberedChain(key, remembered), capabilities));
    return resolutions;
  }

  // Compose the inner shell command for a launch of `kind`: with a configured adapter
  // the console composes [program, …adapter args, …operator args]; otherwise it falls
  // back to the caller's legacy composition, which receives the Adapter's mode args.
  private composeKindLaunch(kind: AgentKind, input: LaunchInput, legacy: (adapterArgs: string[]) => string | undefined): string | undefined {
    const adapter = adapterFor(kind);
    if (adapter === undefined) return undefined;
    const spec = adapter.launch(input);
    const configured = this.config.adapters?.[kind];
    return configured === undefined ? legacy(spec.args) : composeLaunch(configured.program, spec.args, configured.args, spec.env, configured.env);
  }

  // the inner command for a worktree launch; a Project has no per-checkout launch command,
  // so a kind with no configured Adapter simply cannot launch (legacy returns undefined)
  private async worktreeCommand(worktree: Worktree, kind: AgentKind, input: LaunchRequest): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), cwd: worktree.identity, sandboxed: input.sandboxed, ...(files === undefined ? {} : { files }) }, () => undefined);
  }

  // the inner command for a scratch launch; the legacy path launches newAgentCommand
  private async scratchCommand(kind: AgentKind, cwd: string): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: 'fresh', cwd, sandboxed: false, ...(files === undefined ? {} : { files }) }, adapterArgs => composeCommand(this.config.newAgentCommand, adapterArgs));
  }

  // resolve the authenticated account home independently from the launch directory
  agentHome(): string {
    const hostPath = this.config.projects.find(project => project.hostPath !== undefined)?.hostPath;
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
  // launch one ordinary home scratch agent of the resolved (or requested) kind
  async launchHome(kind?: AgentKind): Promise<boolean> {
    const resolved = await this.resolveLaunchKind(scratchLaunchKey, kind);
    // refuse an unconfigured or unlaunchable kind
    if (resolved === undefined) return false;
    const home = this.agentHome();
    const command = await this.scratchCommand(resolved, home);
    if (command === undefined) return false;
    const launched = await this.launchScratch(home, scratchLabel, command, home);
    // remember the Scratch group's last-used kind
    // persisting the profile is best-effort; a storage failure never fails a live launch
    if (launched) await this.worktreeStore.rememberLaunchProfile(scratchLaunchKey, resolved).catch(() => {});
    return launched;
  }

  // launch one dedicated advisor in a fixed server-owned checkout
  async launchUpdateAdvisor(repository: string, targetSha: string): Promise<boolean> {
    // reject malformed internal paths
    if (!repository.startsWith('/') || repository.includes('\0') || !isFullGitSha(targetSha)) return false;
    const program = this.codexProgram();
    // report unavailable when no Codex binary is configured
    if (program === undefined) return false;
    const command = composeLaunch(program, updateAdvisorArgs, []);
    return await this.launchScratch(repository, updateAdvisorPendingLabel(targetSha), command, this.agentHome());
  }

  // launch one uniquely labeled scratch session with an already-composed command
  private async launchScratch(directory: string, label: string, command: string, home = directory): Promise<boolean> {
    const key = `scratch:${directory}:${label}`;
    // serialize matching scratch launches
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const id = randomBytes(18).toString('base64url');
      const session = `rac-${id.slice(0, 12)}`;
      const expanded = expandHomeCommand(command, directory);
      // launch through the host bridge when configured
      if (this.hostSocket !== undefined) {
        if ((await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', session, '-c', directory, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand(expanded, home), home, this.hostShell)])).code !== 0) return false;
        return await this.labelScratchSession(session, label);
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const descriptor = join(this.root, `${id}.json`);
      const handle = await open(descriptor, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ program: this.localShell, args: ['-lc', interactiveShellBootstrap(expanded, home, this.localShell)], cwd: directory }));
      await handle.close();
      const runner = new URL('./runner.js', import.meta.url).pathname;
      const created = await run(this.tmux, ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]);
      // clean failed launch descriptors
      if (created.code !== 0) { await unlink(descriptor).catch(() => {}); return false; }
      return await this.labelScratchSession(session, label);
    } finally { this.pending.delete(key); }
  }

  // launch a fresh agent in a worktree, resolving the kind (or using the requested one)
  async launch(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'fresh', ...(kind === undefined ? {} : { kind }) });
  }

  // resume the previous conversation (Codex: `codex resume --last`), no shell alias
  async resume(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'continue', ...(kind === undefined ? {} : { kind }) });
  }

  // resume one exact bookmarked conversation by its id, through its Adapter kind
  async resumeConversation(worktreeId: string, threadId: string, kind?: AgentKind): Promise<boolean> {
    // keep the host command free of shell input, whether the id is quoted or substituted
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)) return false;
    return await this.launchWorktree(worktreeId, { mode: 'resume', conversationId: threadId, ...(kind === undefined ? {} : { kind }) });
  }

  // expose exact-resume support before destructive lifecycle work: a configured
  // adapter resumes through the Adapter; the legacy path needs a command or template
  canResumeConversation(worktreeId: string): boolean {
    const worktree = this.worktreeById(worktreeId);
    if (worktree === undefined) return false;
    // a configured Adapter resumes through the Adapter; the legacy path had a per-worktree
    // command or template, which Projects retired, so only a configured Adapter can resume
    return this.config.adapters !== undefined && this.launchableKinds().length > 0;
  }

  // start one worktree in the requested mode, composing its command from the Adapter
  private async launchWorktree(worktreeId: string, input: { mode: LaunchMode; conversationId?: string; sandboxed?: boolean; kind?: AgentKind }): Promise<boolean> {
    const worktree = this.worktreeById(worktreeId);
    // serialize each worktree launch
    if (!worktree || this.pending.has(worktreeId)) return false;
    this.pending.add(worktreeId);
    try {
      // refuse an unconfigured or unlaunchable kind
      const kind = await this.resolveLaunchKind(worktreeId, input.kind);
      if (kind === undefined) return false;
      const id = randomBytes(18).toString('base64url');
      const sandboxed = input.sandboxed === true;
      const command = await this.worktreeCommand(worktree, kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), sandboxed });
      // a worktree with no launch command (and no override) cannot start
      if (command === undefined) return false;
      const launched = await this.dispatchWorktreeLaunch(worktree, command, id, sandboxed);
      // record the kind so it resolves first next time — for this Worktree and for its
      // Project (which seeds a fresh Worktree); storage failure never fails a live launch
      if (launched) {
        await this.worktreeStore.rememberLaunchProfile(worktreeId, kind).catch(() => {});
        await this.worktreeStore.rememberLaunchProfile(worktree.projectId, kind).catch(() => {});
      }
      return launched;
    } finally {
      this.pending.delete(worktreeId);
    }
  }

  // dispatch a composed worktree launch: reuse an idle shell, else start a session
  private async dispatchWorktreeLaunch(worktree: Worktree, command: string, id: string, sandboxed: boolean): Promise<boolean> {
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
  }

  // Start the Worktree's own idle interactive shell — a login shell in the checkout, no
  // agent command — so a freshly added Worktree gets a tab (and a shell the ordinary
  // launch path then reuses) even when the operator declines to launch an agent. Its
  // session name is `basename(worktree dir)` like a launch, but gains `-2`/`-3` suffixes
  // when a different Worktree already holds that name (two Projects can share a checkout
  // basename), so it never displaces another. Because there is no command to keep out of
  // the process table, it skips the runner indirection and execs the login shell directly,
  // so the pane reports the shell immediately and the launch path can adopt it at once.
  async startWorktreeShell(worktree: Worktree): Promise<boolean> {
    const name = await this.availableSessionName(worktreeSessionName(worktreeHostRoot(worktree)));
    if (this.hostSocket !== undefined) {
      const hostRoot = worktreeHostRoot(worktree);
      const home = dirname(hostRoot);
      // the bridge shell still needs the host HOME/PATH the launch bootstrap sets
      const tail = ['-c', hostRoot, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand('', home), home, this.hostShell)];
      return (await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', name, ...tail])).code === 0;
    }
    return (await run(this.tmux, ['new-session', '-d', '-s', name, '-c', worktree.identity, this.localShell, '-l'])).code === 0;
  }

  // a session name free on the relevant socket: the base name, else `-2`/`-3`/… — so a
  // new Worktree's idle shell never collides with a same-basename Worktree of another
  // Project. Falls back to a random suffix after a run of taken names.
  private async availableSessionName(base: string): Promise<string> {
    const socket = this.hostSocket === undefined ? [] : ['-S', this.hostSocket];
    const listed = await run(this.tmux, [...socket, 'list-sessions', '-F', '#{session_name}']);
    const taken = new Set(listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '') : []);
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix <= 99; suffix += 1) { const candidate = `${base}-${suffix}`; if (!taken.has(candidate)) return candidate; }
    return `${base}-${randomBytes(4).toString('hex')}`;
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
