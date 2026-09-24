import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
import { accountHome, configuredPlaces, placeForRoot, placeHostRoot, scratchHome, scratchPlaceLabel, scratchProjectId, type Place } from '../places/places.js';

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
// shell-quoted assignment prefix. The program, args, and env are all quoted, so
// nothing in them expands. A configured `setup` command is the one deliberately
// raw part — operator-trust shell (like a Project's stack commands) — run in the
// launched pane before the program, in the launch cwd. It is wrapped in its own
// `eval '<setup>'` so it is a single command whose exit status gates the program
// through `&&`: a non-zero setup stops the agent from ever starting, and a
// compound setup (`a || b`, `a; b`, a multi-line command) cannot re-associate the
// `&&` and silently launch or skip the program.
export function composeLaunch(program: string, adapterArgs: string[], operatorArgs: string[], adapterEnv: Record<string, string> = {}, operatorEnv: Record<string, string> = {}, setup?: string): string {
  const env = { ...adapterEnv, ...operatorEnv };
  const prefix = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ');
  const command = composeCommand(shellQuote(program), [...adapterArgs, ...operatorArgs]);
  const launch = prefix === '' ? command : `${prefix} ${command}`;
  return setup === undefined ? launch : `eval ${shellQuote(setup)} && ${launch}`;
}

// what a Console shell needs of its Place: membership, where it starts and whose HOME it exports
export type ConsoleShellPlace = Pick<Place, 'id' | 'kind' | 'projectId' | 'home' | 'hostPath'>;

// one worktree launch request: which conversation (if any) and whether to confine it
type LaunchRequest = { mode: LaunchMode; conversationId?: string; sandboxed: boolean };

// one tmux session on its socket: the session a launch or a Console shell at a Place joins
export type TmuxSession = { socket: SocketRef; session: string };

// where a launch runs: the folder tmux opens it in (the host-visible one under the bridge) and
// the HOME its shell exports (`$HOME` leaves a local shell's own)
type LaunchSite = { cwd: string; home: string };

export function expandHomeCommand(command: string, home: string): string {
  return expandCommand(command, { identity: home });
}

export const scratchLabel = scratchPlaceLabel;

// The session a directory-Project or Scratch Place's launches and Console shells start in, named
// for its folder. tmux turns `.` into `_` in a session name, so the name is written that way up
// front and the free-name check compares what tmux will actually list.
const placeSessionName = (place: Pick<Place, 'home' | 'hostPath'>): string => worktreeSessionName(placeHostRoot(place)).replaceAll('.', '_');
// allow approved host repairs and verification
const updateAdvisorArgs = ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];

export class LaunchService {
  private pending = new Set<string>();
  // the configured Scratch folder's realpath, resolved once
  private scratchHomeValue?: Promise<string>;
  private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly localShell = interactiveShellPath();
  private readonly localShellName = interactiveShellName(this.localShell);
  private readonly hostShell = hostInteractiveShellPath();
  private readonly hostShellName = interactiveShellName(this.hostShell);
  // the login shell basename a Console shell reports when idle, for the busy check on End
  private get shellName(): string { return this.hostSocket === undefined ? this.localShellName : this.hostShellName; }
  // `root` (where launch descriptors are written for the local runner path) is a test seam.
  // `openTerminals` returns the `fingerprint\0paneId` keys of panes a browser currently has
  // open as a Terminal (a live pane-socket subscriber); adoption and Remove's blind kill skip
  // them so a Launch never pastes into, or kills, a pane the operator is reading (spec).
  // `placeAgentSession` finds the session of a live Agent at a Place (from discovery, since an
  // Agent adopted into the operator's own session lives wherever), which a Place launch joins.
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter(), private readonly paneRoot: (path: string) => Promise<string> = workspaceRoot, private readonly worktreeStore: WorktreeLaunchStore = new WorktreeLaunchStore(), private readonly discoveredWorktrees: () => Worktree[] = () => [], private readonly openTerminals: () => ReadonlySet<string> = () => new Set(), private readonly placeAgentSession: (placeId: string) => Promise<TmuxSession | undefined> = async () => undefined, private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`) {}

  // a pane the operator currently has open as a Terminal (a live pane-socket subscriber)
  private paneHasOpenTerminal(pane: Pane): boolean {
    return this.openTerminals().has(`${pane.socket.fingerprint}\0${pane.paneId}`);
  }

  // one discovered Worktree by its wire id `<projectId>:<realpath>`
  private worktreeById(worktreeId: string): Worktree | undefined {
    return this.discoveredWorktrees().find(candidate => candidate.id === worktreeId);
  }

  // the Codex binary in the environment where the update advisor actually runs
  codexProgram(): string | undefined {
    const hostProgram = process.env.RAC_HOST_CODEX_BIN?.trim();
    // host tmux cannot execute a container-only RAC_CODEX_BIN path
    if (this.hostSocket !== undefined) return hostProgram || this.config.adapters.codex?.program;
    return resolveCodexProgram(this.config);
  }

  private adapterFilesPromise: Promise<RenderedAdapterFiles> | undefined;
  // This kind's rendered console-owned files for `LaunchInput.files`, or `undefined`
  // when the kind declares none (Codex) — which keeps the
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
    return agentKinds.filter(kind => (this.config.adapters[kind]?.launchable ?? false) && adapterFor(kind) !== undefined);
  }

  // expose the effective server default, falling back when its configured kind is unavailable
  defaultAgent(): AgentKind | undefined {
    const launchable = this.launchableKinds();
    return this.config.defaultAgent !== undefined && launchable.includes(this.config.defaultAgent) ? this.config.defaultAgent : launchable[0];
  }

  // accept settings choices only for kinds this server can launch now
  isLaunchableKind(kind: AgentKind): boolean {
    return this.launchableKinds().includes(kind);
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
    return resolveLaunchProfile(kinds, this.rememberedChain(scopeKey, remembered), adapterCapabilities(this.config.adapters), this.defaultAgent()).kind;
  }

  // the remembered-kind precedence for one scope: a Worktree's own last-used kind, then
  // its Project's (which seeds a fresh Worktree), then registry order; Scratch stands alone,
  // and a Scratch Place (`scratch:<root>`) falls back to the Scratch group, both in the scratch scope
  private rememberedChain(key: string, remembered: Record<string, AgentKind | undefined>): Array<{ origin: LaunchScope; kind?: AgentKind }> {
    if (key === scratchLaunchKey) return [{ origin: 'scratch', kind: remembered[key] }];
    const projectId = projectIdOf(key);
    if (projectId === scratchProjectId) return [{ origin: 'scratch', kind: remembered[key] }, { origin: 'scratch', kind: remembered[scratchLaunchKey] }];
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
    for (const key of new Set(scopeKeys)) resolutions.set(key, resolveLaunchProfile(launchable, this.rememberedChain(key, remembered), capabilities, this.defaultAgent()));
    return resolutions;
  }

  // Compose the inner shell command for a launch of `kind`: [program, …adapter args,
  // …operator args] from the kind's configured entry. A kind with no entry cannot launch.
  private composeKindLaunch(kind: AgentKind, input: LaunchInput): string | undefined {
    const adapter = adapterFor(kind);
    const configured = this.config.adapters[kind];
    if (adapter === undefined || configured === undefined) return undefined;
    const spec = adapter.launch(input);
    return composeLaunch(configured.program, spec.args, configured.args, spec.env, configured.env, configured.setup);
  }

  // the inner command for a worktree launch
  private async worktreeCommand(worktree: Worktree, kind: AgentKind, input: LaunchRequest): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), cwd: worktree.identity, sandboxed: input.sandboxed, ...(files === undefined ? {} : { files }) });
  }

  // the inner command for a scratch launch
  private async scratchCommand(kind: AgentKind, cwd: string): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: 'fresh', cwd, sandboxed: false, ...(files === undefined ? {} : { files }) });
  }

  // resolve the authenticated account home independently from the launch directory
  agentHome(projectId?: string): string {
    return accountHome(this.config.projects, projectId);
  }

  // every configured Place over the current Worktree snapshot
  private async places(): Promise<Place[]> {
    this.scratchHomeValue ??= scratchHome(this.config.scratchDirectory, this.config.projects);
    return configuredPlaces(this.discoveredWorktrees(), this.config.projects, await this.scratchHomeValue);
  }

  // the configured Scratch folder's Place, which a Scratch launch joins
  async scratchPlace(): Promise<Place> {
    const place = (await this.places()).find(candidate => candidate.kind === 'scratch');
    // configuredPlaces always lists the configured Scratch folder
    if (place === undefined) throw new Error('no configured Scratch Place');
    return place;
  }

  // the Place of an available directory Project, which its in-place launch joins
  async directoryPlace(projectId: string): Promise<Place | undefined> {
    return (await this.places()).find(candidate => candidate.kind === 'directory' && candidate.projectId === projectId);
  }

  // the id of the Place a pane belongs to; a pane already at a Worktree's root needs no git
  // resolution (it is its own toplevel), any other cwd resolves its root as discovery does
  private async placeIdOf(places: readonly Place[], paneCwd: string): Promise<string> {
    const atWorktree = places.some(place => place.kind === 'worktree' && (place.home === paneCwd || place.hostPath === paneCwd));
    return placeForRoot(places, atWorktree ? paneCwd : await this.paneRoot(paneCwd)).id;
  }
  // An idle login shell a launch could adopt: never a transient stack-command pane, a Console
  // shell (its own, operator-owned pane) or a pane the operator has open as a Terminal, so a
  // Launch cannot paste into what someone is typing into or reading.
  private idleLandingShell(pane: Pane): boolean {
    if (pane.sessionName?.startsWith('rac-stack-')) return false;
    if (pane.role === 'shell' || this.paneHasOpenTerminal(pane)) return false;
    return pane.command === this.hostShellName;
  }

  // every pane on every socket, the sockets listed concurrently, in discovery order
  private async listedPanes(): Promise<Array<{ socket: SocketRef; pane: Pane }>> {
    const sockets = await this.finder.find();
    const listed = await Promise.all(sockets.map(async socket => ({ socket, panes: await this.panes.listPanes(socket) })));
    return listed.flatMap(({ socket, panes }) => panes.map(pane => ({ socket, pane })));
  }

  // find one unlabeled worktree shell that no modal or scratch flow owns
  private async existingPane(worktree: Worktree): Promise<{ socket: SocketRef; pane: Pane } | undefined> {
    // the first match in discovery order wins
    for (const { socket, pane } of await this.listedPanes()) {
      // preserve labeled scratch and modal panes
      if (pane.displayLabel !== undefined) continue;
      if (!this.idleLandingShell(pane)) continue;
      // reuse a shell only when its git toplevel is exactly this worktree, never a
      // parent whose subtree holds a nested checkout (a `.claude/worktrees/<n>` the
      // agent's own tool created); a subdirectory of the worktree still resolves here.
      // Stricter than Place membership, which counts a nested checkout as the Worktree's:
      // an adopted shell is where the Agent runs, so it must be the Worktree itself.
      if (!await this.paneRootIsWorktree(worktree, pane.path)) continue;
      return { socket, pane };
    }
    return undefined;
  }

  // The idle shell a directory-Project or Scratch launch adopts: one an earlier launch at this
  // Place created (its Agent exited back to the shell), whose root is still the Place home itself.
  // The Place label is the proof of origin: only a Place launch writes it, on a pane it created or
  // on one that already carried it, whereas `@rac_console_managed` is also set on an operator's own
  // shell a Worktree launch adopted. A Scratch home is often the account home, where the
  // operator's own tmux shells start, so nothing else is ever pasted into; and never a subfolder,
  // as a Worktree adopts only a shell at its own toplevel.
  private async adoptablePlaceShell(place: Place): Promise<{ socket: SocketRef; pane: Pane } | undefined> {
    for (const { socket, pane } of await this.listedPanes()) {
      if (pane.displayLabel !== place.label || pane.consoleManaged !== true || !this.idleLandingShell(pane)) continue;
      const root = await this.paneRoot(pane.path);
      if (root !== place.home && root !== place.hostPath) continue;
      return { socket, pane };
    }
    return undefined;
  }

  // the session a launch or a Console shell at a Place joins: its live Agent's, else the one
  // holding its Console shells (a Worktree launch joins only the latter; see dispatchWorktreeLaunch)
  private async placeSession(place: Pick<Place, 'id'>): Promise<TmuxSession | undefined> {
    const agent = await this.placeAgentSession(place.id);
    if (agent !== undefined) return agent;
    const shell = (await this.placeConsoleShells(place))[0];
    return shell === undefined ? undefined : { socket: shell.socket, session: shell.sessionId };
  }

  // Kill every idle interactive shell sitting exactly in this Worktree — Remove's first
  // step, so a removed checkout leaves no dangling shell pane behind. Matches the same
  // panes `existingPane` would reuse (the login shell, cwd exactly the Worktree, never a
  // `rac-stack-*` session), but every one rather than the first. An agent that adopted the
  // shell no longer reports the shell command, so a running Agent's pane is never touched.
  async killWorktreeShells(worktree: Worktree): Promise<void> {
    for (const { socket, pane } of await this.listedPanes()) {
      // leave a Console shell and any pane open as a Terminal alone; the operator ends those
      // deliberately (Remove is separately refused while a Console shell exists)
      if (!this.idleLandingShell(pane)) continue;
      if (!await this.paneRootIsWorktree(worktree, pane.path)) continue;
      await this.panes.close(socket, pane.paneId).catch(() => false);
    }
  }

  // the Console shells the operator created at this Place: panes marked `@rac_role=shell`
  // that belong to the Place by the nearest-Place rule (identity = marker + cwd, spec). Drives
  // the panes API, the Remove gate, and the launch "join the shells' session" rule.
  async placeConsoleShells(place: Pick<Place, 'id'>): Promise<Pane[]> {
    const [places, sockets] = await Promise.all([this.places(), this.finder.find()]);
    const listed = await Promise.all(sockets.map(async socket => ({ socket, panes: await this.panes.listPanes(socket) })));
    const shells: Pane[] = [];
    for (const { panes } of listed) for (const pane of panes) {
      if (pane.role !== 'shell') continue;
      if (await this.placeIdOf(places, pane.path) !== place.id) continue;
      shells.push(pane);
    }
    return shells;
  }

  // Every pane the console may stream for a Place: every pane of every tmux session that
  // holds at least one pane belonging to the Place (its live Agent's window, its Console
  // shells, an idle landing shell), which subsumes the Place's Console shells wherever they
  // sit. Membership for the Place pane socket and the source of the panes-API listing.
  async placePanes(place: Pick<Place, 'id'>): Promise<Pane[]> {
    const [places, sockets] = await Promise.all([this.places(), this.finder.find()]);
    const all = (await Promise.all(sockets.map(socket => this.panes.listPanes(socket)))).flat();
    const belongs = await Promise.all(all.map(async pane => await this.placeIdOf(places, pane.path) === place.id));
    const sessions = new Set<string>();
    all.forEach((pane, index) => { if (belongs[index]) sessions.add(`${pane.socket.fingerprint}\0${pane.sessionId}`); });
    return all.filter(pane => sessions.has(`${pane.socket.fingerprint}\0${pane.sessionId}`));
  }

  // whether a Console shell is busy (its foreground command is not the login shell), so the
  // panes API can ask the operator to confirm ending it
  consoleShellBusy(pane: Pane): boolean {
    return pane.command !== this.shellName;
  }

  // is a shell's git toplevel exactly this worktree (a subdirectory counts, a nested checkout does not)?
  private async paneRootIsWorktree(worktree: Worktree, paneCwd: string): Promise<boolean> {
    // a shell already at the worktree root needs no git resolution
    if (worktreeMatchesWorkspace(worktree, paneCwd)) return true;
    return worktreeMatchesWorkspace(worktree, await this.paneRoot(paneCwd));
  }
  // label a pane (or a session's active pane) so its tab reads as its Place or modal flow
  private async labelPane(socketPath: string | undefined, target: string, label: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_display_label', label])).code === 0;
  }
  // launch one ordinary scratch agent of the resolved (or requested) kind at the Scratch Place:
  // the configured Scratch directory when set, else the account home
  async launchHome(kind?: AgentKind): Promise<boolean> {
    const resolved = await this.resolveLaunchKind(scratchLaunchKey, kind);
    // refuse an unconfigured or unlaunchable kind
    if (resolved === undefined) return false;
    const launched = await this.launchInPlace(await this.scratchPlace(), resolved);
    // remember the Scratch group's last-used kind
    // persisting the profile is best-effort; a storage failure never fails a live launch
    if (launched) await this.worktreeStore.rememberLaunchProfile(scratchLaunchKey, resolved).catch(() => {});
    return launched;
  }

  // launch one agent directly in a non-git `directory` Project — the same in-place spawn
  // Scratch uses (no Worktree), joining the Project's Place and labeled with the Project so
  // its tab reads as the Project; discovery keeps its notes and console-named conversations
  // under the Scratch persistence key for the directory. Only an available `directory` Project
  // launches this way: a `repository` Project launches through its Worktrees, and an
  // unavailable one has nothing to launch into. Remembers the kind under the Project scope.
  async launchProjectDirectory(projectId: string, kind?: AgentKind): Promise<boolean> {
    const place = await this.directoryPlace(projectId);
    if (place === undefined) return false;
    const resolved = await this.resolveLaunchKind(projectId, kind);
    // refuse an unconfigured or unlaunchable kind
    if (resolved === undefined) return false;
    const launched = await this.launchInPlace(place, resolved);
    // remember the Project group's last-used kind; storage failure never fails a live launch
    if (launched) await this.worktreeStore.rememberLaunchProfile(projectId, resolved).catch(() => {});
    return launched;
  }

  // launch one dedicated advisor in a fixed server-owned checkout
  async launchUpdateAdvisor(repository: string, targetSha: string): Promise<boolean> {
    // reject malformed internal paths
    if (!repository.startsWith('/') || repository.includes('\0') || !isFullGitSha(targetSha)) return false;
    const program = this.codexProgram();
    // report unavailable when no Codex binary is configured
    if (program === undefined) return false;
    // the advisor launches the codex kind, so it gets the same pre-launch repair —
    // but only when its resolved program is the configured one
    const configured = this.config.adapters.codex;
    const command = composeLaunch(program, updateAdvisorArgs, [], {}, {}, program === configured?.program ? configured.setup : undefined);
    const label = updateAdvisorPendingLabel(targetSha);
    // the advisor is a modal flow, never part of a Place: its own uniquely named session every time
    const key = `advisor:${repository}:${label}`;
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const id = randomBytes(18).toString('base64url');
      const session = `rac-${id.slice(0, 12)}`;
      const pane = await this.startLaunchSession({ cwd: repository, home: this.agentHome() }, command, id, session);
      return pane !== undefined && await this.labelPane(this.hostSocket, pane, label);
    } finally { this.pending.delete(key); }
  }

  // Launch into a directory-Project or Scratch Place the way a Worktree launch joins its own:
  // adopt the Place's idle console-launched shell, else open a window in the session holding its
  // live Agent or its Console shells, else start a session named for the Place. The Agent is
  // labelled with the Place so its tab reads as the Place. One launch per Place at a time.
  private async launchInPlace(place: Place, kind: AgentKind): Promise<boolean> {
    if (this.pending.has(place.id)) { console.warn(`[launch] ${place.home}: a launch is already in progress`); return false; }
    this.pending.add(place.id);
    try {
      // under the Docker bridge the host-visible path is what the host tmux can cd into; HOME is
      // the default account home for every directory-Project and Scratch launch
      const site: LaunchSite = { cwd: placeHostRoot(place), home: this.agentHome() };
      const command = await this.scratchCommand(kind, site.cwd);
      if (command === undefined) { console.warn(`[launch] ${place.home}: agent kind ${kind} produced no launch command`); return false; }
      const id = randomBytes(18).toString('base64url');
      const existing = await this.adoptablePlaceShell(place);
      if (existing !== undefined) {
        const reused = await this.launchInShell(existing, command, id, false) && await this.labelPane(existing.socket.path, existing.pane.paneId, place.label);
        if (!reused) console.error(`[launch] ${place.home}: could not send the launch into reused shell ${existing.pane.paneId}`);
        return reused;
      }
      const joined = await this.placeSession(place);
      if (joined !== undefined) {
        const pane = await this.launchInSessionWindow(site, command, id, false, joined, place.home);
        return pane !== undefined && await this.labelPane(joined.socket.path, pane, place.label);
      }
      const session = await this.availableSessionName(placeSessionName(place));
      const pane = await this.startLaunchSession(site, command, id, session);
      if (pane === undefined) { console.error(`[launch] ${place.home}: tmux could not start session '${session}'`); return false; }
      return await this.labelPane(this.hostSocket, pane, place.label) && await this.markConsoleManaged(this.hostSocket, pane);
    } finally {
      this.pending.delete(place.id);
    }
  }

  // Start a detached session running the composed launch at the site — the host bootstrap on the
  // bridge socket, else the local runner, which keeps the command out of the process table — and
  // return its pane id, which later options target: a bare session name can resolve to a window
  // of the same name in another session.
  private async startLaunchSession(site: LaunchSite, command: string, id: string, session: string): Promise<string | undefined> {
    let created: { code: number; stdout: string; stderr: string };
    if (this.hostSocket !== undefined) created = await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', session, '-c', site.cwd, '-P', '-F', '#{pane_id}', ...this.hostLaunchArgv(site, command)]);
    else {
      const { descriptor, runner } = await this.writeLaunchDescriptor(id, command, site);
      created = await run(this.tmux, ['new-session', '-d', '-s', session, '-P', '-F', '#{pane_id}', process.execPath, runner, descriptor]);
      // clean failed launch descriptors
      if (created.code !== 0) await unlink(descriptor).catch(() => {});
    }
    if (created.code !== 0) { console.error(`[launch] ${site.cwd}: tmux new-session '${session}' failed (code ${created.code})${created.stderr.trim() === '' ? '' : `: ${created.stderr.trim()}`}`); return undefined; }
    return created.stdout.trim();
  }

  // the host login shell running the composed launch at the site, through the interactive bootstrap
  private hostLaunchArgv(site: LaunchSite, command: string): string[] {
    return [this.hostShell, '-lc', interactiveShellBootstrap(hostCommand(expandHomeCommand(command, site.cwd), site.home), site.home, this.hostShell)];
  }

  // where a worktree launch runs: its host root with its Project's account home on the bridge,
  // else the checkout with the local shell's own HOME
  private worktreeSite(worktree: Worktree): LaunchSite {
    return this.hostSocket === undefined ? { cwd: worktree.identity, home: '$HOME' } : { cwd: worktreeHostRoot(worktree), home: this.agentHome(worktree.projectId) };
  }

  // send a composed launch into an adopted idle shell, marking it console-managed (and Sandboxed)
  private async launchInShell(existing: { socket: SocketRef; pane: Pane }, command: string, id: string, sandboxed: boolean): Promise<boolean> {
    const buffer = `rac-launch-${id}`;
    return await this.panes.pastePrompt(existing.socket, existing.pane.paneId, buffer, command)
      && await this.panes.enter(existing.socket, existing.pane.paneId)
      && await this.markConsoleManaged(existing.socket.path, existing.pane.paneId)
      && await this.markSandboxed(existing.socket.path, existing.pane.paneId, sandboxed);
  }

  // launch a fresh agent in a worktree, resolving the kind (or using the requested one)
  async launch(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'fresh', ...(kind === undefined ? {} : { kind }) });
  }

  // resume the previous conversation (Codex: `codex resume --last`), no shell alias
  async resume(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'continue', ...(kind === undefined ? {} : { kind }) });
  }

  // resume one exact listed conversation by its id, through its Adapter kind
  async resumeConversation(worktreeId: string, threadId: string, kind?: AgentKind): Promise<boolean> {
    // validate the id through the resuming Adapter rather than a hard-coded UUID pattern, so a
    // kind whose ids are not UUIDs still resumes; a validated id also keeps the host command
    // free of shell input, whether the id is quoted or substituted
    const resumeKind = kind ?? await this.resolveLaunchKind(worktreeId);
    if (resumeKind === undefined || adapterFor(resumeKind)?.conversations?.validId(threadId) !== true) return false;
    return await this.launchWorktree(worktreeId, { mode: 'resume', conversationId: threadId, kind: resumeKind });
  }

  // expose exact-resume support before destructive lifecycle work: a known Worktree
  // resumes through any launchable Adapter
  canResumeConversation(worktreeId: string): boolean {
    return this.worktreeById(worktreeId) !== undefined && this.launchableKinds().length > 0;
  }

  // start one worktree in the requested mode, composing its command from the Adapter
  private async launchWorktree(worktreeId: string, input: { mode: LaunchMode; conversationId?: string; sandboxed?: boolean; kind?: AgentKind }): Promise<boolean> {
    const worktree = this.worktreeById(worktreeId);
    // Every refusal below logs its reason. The web only ever sees a bare "couldn't
    // start", so without this the operator has nothing to diagnose from — the cause
    // never leaves this method (see the sibling logs in dispatchWorktreeLaunch).
    if (worktree === undefined) { console.warn(`[launch] no worktree matches id ${worktreeId}`); return false; }
    // serialize each worktree launch
    if (this.pending.has(worktreeId)) { console.warn(`[launch] ${worktree.identity}: a launch is already in progress`); return false; }
    this.pending.add(worktreeId);
    try {
      const kind = await this.resolveLaunchKind(worktreeId, input.kind);
      // refuse an unconfigured or unlaunchable kind
      if (kind === undefined) { console.warn(`[launch] ${worktree.identity}: no launchable agent kind (check adapters.*.launchable and the agent binary)`); return false; }
      const id = randomBytes(18).toString('base64url');
      const sandboxed = input.sandboxed === true;
      const command = await this.worktreeCommand(worktree, kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), sandboxed });
      // a worktree with no launch command (and no override) cannot start
      if (command === undefined) { console.warn(`[launch] ${worktree.identity}: agent kind ${kind} produced no launch command`); return false; }
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
      const reused = await this.launchInShell(existing, command, id, sandboxed);
      if (!reused) console.error(`[launch] ${worktree.identity}: could not send the launch into reused shell ${existing.pane.paneId}`);
      return reused;
    }
    // no adoptable idle shell: if the Worktree already has Console shells, add the Agent's
    // window to the session holding them, so an attached terminal keeps the agent and the
    // shells together, rather than opening a separate session (spec, Console shells)
    const shells = await this.placeConsoleShells(worktree);
    const shellSession = shells[0];
    const site = this.worktreeSite(worktree);
    if (shellSession !== undefined) return await this.launchInSessionWindow(site, command, id, sandboxed, { socket: shellSession.socket, session: shellSession.sessionId }, worktree.identity) !== undefined;
    const session = worktreeSessionName(worktreeHostRoot(worktree));
    // launch host-mounted worktrees on the host socket, the site keeping credentials and CLI
    // state rooted in the authenticated account
    if (this.hostSocket !== undefined) {
      const tail = ['-c', site.cwd, ...this.hostLaunchArgv(site, command)];
      // the host socket is RAC's own, so displacing a same-named session in place is safe
      if (!await startNamedReplacementSession(this.tmux, this.hostSocket, session, session, tail)) {
        console.error(`[launch] ${worktree.identity}: tmux could not start host session '${session}'`);
        return false;
      }
      return await this.markConsoleManaged(this.hostSocket, session)
        && await this.markSandboxed(this.hostSocket, session, sandboxed);
    }
    const { descriptor, runner } = await this.writeLaunchDescriptor(id, command, site);
    // Unlike the host socket, the default socket is shared with the operator's own tmux,
    // so a same-named session is just as likely theirs. Suffix past a taken name
    // (`-2`/`-3`, as startWorktreeShell does) rather than a bare new-session that fails —
    // that collision is what surfaced as a silent "couldn't start".
    const name = await this.availableSessionName(session);
    const created = await run(this.tmux, ['new-session', '-d', '-s', name, process.execPath, runner, descriptor]);
    // remove rejected launch descriptors
    if (created.code !== 0) {
      console.error(`[launch] ${worktree.identity}: tmux new-session '${name}' failed (code ${created.code})${created.stderr.trim() === '' ? '' : `: ${created.stderr.trim()}`}`);
      await unlink(descriptor).catch(() => {});
      return false;
    }
    return await this.markConsoleManaged(undefined, name)
      && await this.markSandboxed(undefined, name, sandboxed);
  }

  // Launch the Agent in a new detached window of an existing session (the session holding the
  // Place's Console shells or live Agent), mirroring the fresh-session dispatch but with
  // `new-window` — the same host bootstrap / local runner split. Returns the new pane, marked
  // console-managed (and Sandboxed when asked), or undefined; `logName` names the Place in logs.
  private async launchInSessionWindow(site: LaunchSite, command: string, id: string, sandboxed: boolean, { socket, session }: TmuxSession, logName: string): Promise<string | undefined> {
    const logFailure = (created: { code: number; stderr: string }) => console.error(`[launch] ${logName}: tmux new-window in '${session}' failed (code ${created.code})${created.stderr.trim() === '' ? '' : `: ${created.stderr.trim()}`}`);
    let pane: string;
    if (this.hostSocket !== undefined) {
      const created = await run(this.tmux, ['-S', socket.path, 'new-window', '-d', '-t', session, '-c', site.cwd, '-P', '-F', '#{pane_id}', '--', ...this.hostLaunchArgv(site, command)]);
      if (created.code !== 0) { logFailure(created); return undefined; }
      pane = created.stdout.trim();
    } else {
      const { descriptor, runner } = await this.writeLaunchDescriptor(id, command, site);
      const created = await run(this.tmux, ['-S', socket.path, 'new-window', '-d', '-t', session, '-P', '-F', '#{pane_id}', process.execPath, runner, descriptor]);
      if (created.code !== 0) { logFailure(created); await unlink(descriptor).catch(() => {}); return undefined; }
      pane = created.stdout.trim();
    }
    return await this.markConsoleManaged(socket.path, pane) && await this.markSandboxed(socket.path, pane, sandboxed) ? pane : undefined;
  }

  // Write the local-runner launch descriptor (the composed command wrapped in the interactive
  // bootstrap, run out of the process table) and return the descriptor path plus the runner
  // entrypoint. Shared by every local launch: a fresh session or a window in an existing one.
  private async writeLaunchDescriptor(id: string, command: string, site: LaunchSite): Promise<{ descriptor: string; runner: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const descriptor = join(this.root, `${id}.json`);
    const payload = { program: this.localShell, args: ['-lc', interactiveShellBootstrap(expandHomeCommand(command, site.cwd), site.home, this.localShell)], cwd: site.cwd };
    const handle = await open(descriptor, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(payload));
    await handle.close();
    return { descriptor, runner: new URL('./runner.js', import.meta.url).pathname };
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
      // keep credentials and CLI state rooted in the authenticated account
      const home = this.agentHome(worktree.projectId);
      // the bridge shell still needs the host HOME/PATH the launch bootstrap sets
      const tail = ['-c', hostRoot, this.hostShell, '-lc', interactiveShellBootstrap(hostCommand('', home), home, this.hostShell)];
      return (await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', name, ...tail])).code === 0
        && await this.markConsoleManaged(this.hostSocket, name);
    }
    return (await run(this.tmux, ['new-session', '-d', '-s', name, '-c', worktree.identity, this.localShell, '-l'])).code === 0
      && await this.markConsoleManaged(undefined, name);
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

  // the login-shell command and cwd for a Console shell at a Place: a native login shell in the
  // Place home, or the host bootstrap in its host root on the host socket (same shape as
  // `startWorktreeShell`), with the HOME the Place's own Agent launch exports. Never sandboxed —
  // it is the operator's own shell, not the Agent's.
  private consoleShellCommand(place: ConsoleShellPlace): { cwd: string; argv: string[] } {
    if (this.hostSocket === undefined) return { cwd: place.home, argv: [this.localShell, '-l'] };
    // a Worktree launch exports its Project's account home; directory and Scratch launches the default one
    const home = this.agentHome(place.kind === 'worktree' ? place.projectId : undefined);
    return { cwd: placeHostRoot(place), argv: [this.hostShell, '-lc', interactiveShellBootstrap(hostCommand('', home), home, this.hostShell)] };
  }

  // Open a Console shell at the Place and return the new pane id, or undefined on failure.
  // Placement (spec): a detached window in the session of the Place's live Agent (the caller
  // resolves it from discovery), else the session already holding the Place's Console shells,
  // else a fresh console session named for the Place — so agent and shells stay in one session.
  async createConsoleShell(place: ConsoleShellPlace, name: string): Promise<string | undefined> {
    const { cwd, argv } = this.consoleShellCommand(place);
    const joined = await this.placeSession(place);
    if (joined !== undefined) return await this.panes.createConsoleShellWindow(joined.socket, joined.session, cwd, argv, name);
    return await this.createConsoleShellSession(place, cwd, argv, name);
  }

  // create the Place's first Console shell as a fresh console session named for the Place
  // (the no-live-Agent path); a later Launch adds its window to this session
  private async createConsoleShellSession(place: ConsoleShellPlace, cwd: string, argv: string[], name: string): Promise<string | undefined> {
    const session = await this.availableSessionName(placeSessionName(place));
    const socketArgs = this.hostSocket === undefined ? [] : ['-S', this.hostSocket];
    const created = await run(this.tmux, [...socketArgs, 'new-session', '-d', '-s', session, '-c', cwd, '-P', '-F', '#{pane_id}', '--', ...argv]);
    if (created.code !== 0) return undefined;
    const pane = created.stdout.trim();
    if (await this.markPaneConsoleShell(this.hostSocket, pane, name)) return pane;
    // an unmarked session would be adoptable by a later Launch; tear it down rather than leak it
    await run(this.tmux, [...socketArgs, 'kill-session', '-t', session]);
    return undefined;
  }

  // mark a freshly created session's pane as a Console shell (the fresh-session path already
  // knows its socket, so it sets the options directly rather than through a SocketRef)
  private async markPaneConsoleShell(socketPath: string | undefined, pane: string, name: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    if ((await run(this.tmux, [...socket, 'set-option', '-p', '-t', pane, '@rac_role', 'shell'])).code !== 0) return false;
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', pane, '@rac_pane_name', name])).code === 0;
  }

  // mark panes the console deliberately owns, so retained OMX workers remain launchable; with the
  // Place label, it also lets a later launch at that Place adopt the pane (adoptablePlaceShell)
  private async markConsoleManaged(socketPath: string | undefined, target: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_console_managed', '1'])).code === 0;
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
