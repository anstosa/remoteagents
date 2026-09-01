/**
 * The Adapter interface: every agent CLI the console knows is described by one
 * Adapter (ADR 0002). An Adapter *describes* its agent — how to recognise its
 * processes, what its title says, how a prompt is submitted, how a launch is
 * composed — while the console performs every side effect through its single
 * tmux and `/proc` layer.
 *
 * Chunk 1 populates `kind`, `stateSource`, `recognizes`, `inferState`,
 * `submission`, `launch` and `panes` (plus Codex's existing `turns`/
 * `conversations`, carried as facades). The remaining optional capabilities are
 * declared here so the derived capability record can read their presence; later
 * chunks fill them in.
 */
import type { HostProcess } from '../discovery/processes.js';
import type { CleanupTarget, Pane } from '../domain/models.js';

export const agentKinds = ['codex', 'claude', 'pi', 'opencode'] as const;   // closed union; the registry is code, not plugins
export type AgentKind = typeof agentKinds[number];
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter';

export type SubmissionMode = 'prompt' | 'shell';
export type SubmissionDraftState = 'visible' | 'cleared' | 'unknown';
// `keys` queues behind active work; `idleKeys` may use the Agent's direct submit path
export type Submission = { text: string; keys: TmuxKey[]; idleKeys?: TmuxKey[] };
export type Conversation = { id: string; title?: string };
export type Turn = { prompt?: string; text: string; rows?: number };
export type InlineQuestion = { id: string; text: string; choices: string[]; source: 'structured' | 'parsed'; targetPaneId?: string };
export type PromptCommand = { name: string; description?: string };

export type LaunchMode = 'fresh' | 'continue' | 'resume';
/**
 * What the console hands an Adapter to compose a launch. Chunk 1 supplies
 * `mode`, the `conversationId` for a `resume`, the `cwd`, and the `sandboxed`
 * flag; the Claude chunk adds `files` — the absolute paths of the console-owned
 * files this kind's `files` capability rendered at boot, keyed by name, as the
 * launching host sees them. The Adapter reads these and returns only arguments —
 * the console prepends the program and performs the launch.
 */
export type LaunchInput = { mode: LaunchMode; conversationId?: string; cwd: string; sandboxed: boolean; files?: Record<string, string> };
/** The CLI arguments (and optional environment) for a launch; the console prepends the program. */
export type LaunchSpec = { args: string[]; env?: Record<string, string> };

/**
 * What the console hands an Adapter's `files` renderer at boot: the host-visible
 * checkout root the rendered content and file paths are named against (under the
 * host bridge this is `RAC_HOST_REPOSITORY`), and the tmux binary to bake into a
 * hook command — omitted under the bridge, where the agent runs on the host and
 * the reporter resolves tmux from PATH instead.
 */
export type AdapterFileContext = { repoRoot: string; tmuxBin?: string };

/**
 * The agent-agnostic facts the console feeds `panes.classify`/`classifyProcess`
 * so an Adapter can reproduce its runtime-cleanup rules without embedding any
 * tmux or `/proc` knowledge (ADR 0002). The OMX/HUD rules themselves live in the
 * Adapter; the console only supplies the pane set, the process tree, and the
 * generic derivations (`identity`, `active`, `recognizedKind`, `paneAncestor`).
 */
export type PaneScan = {
  panes: readonly Pane[];
  processes: readonly HostProcess[];
  identity(pane: Pane): string;
  sessionIdentity(pane: Pane): string;
  active(pane: Pane): boolean;
  recognizedKind(pane: Pane): AgentKind | undefined;
  paneAncestor(pid: number): Pane | undefined;
};
/** One runtime-cleanup classification an Adapter emits; the console wraps it with a stable id. */
export type CleanupClassification = Pick<CleanupTarget, 'kind' | 'label' | 'detail'>;
/**
 * The outcome of a turn read from the agent's structured event log: `pending`
 * while no terminal turn has been recorded past the baseline, `completed` (with
 * its answer) for a normal finish, `aborted` for an interrupt or cancellation.
 */
export type CompletionEvent =
  | { kind: 'pending' }
  | { kind: 'completed'; ordinal: number; answer: string }
  | { kind: 'aborted'; ordinal: number };
/**
 * A rollout completion baseline snapshotted before a turn starts: `rollout` pins
 * the exact event-log file the turn will be read from, `ordinal` is that file's
 * max ordinal at the snapshot. Pinning the file (rather than re-resolving it at
 * completion) keeps `baseline` and `since` reading the same rollout even when a
 * sibling pane's rollout later becomes the newest in a shared directory.
 */
export type CompletionBaseline = { rollout: string; ordinal: number };

export interface Adapter {
  readonly kind: AgentKind;
  readonly stateSource: 'reported' | 'title' | 'both';
  /**
   * Operator arguments this Adapter must own, so the console warns (and ignores
   * them) when an `adapters.<kind>.args` entry supplies one — a mode flag or a
   * setting the console composes itself. Codex declares none.
   */
  readonly conflictingArgs?: readonly string[];
  /** Classify one process by its own identity; the wrapper ancestor is the walker's concern. */
  recognizes(process: { comm: string; argv: string[] }): boolean;
  /** The title-derived Attention state, or `undefined` when the title carries no signal. */
  inferState(pane: { title: string; command?: string }): AttentionState | undefined;
  /** The CLI arguments for a fresh/continue/resume launch; the console prepends the program and acts. */
  launch(input: LaunchInput): LaunchSpec;
  readonly submission: {
    prepare(prompt: string, mode: SubmissionMode): Submission;
    /** Observe durable acceptance; absence keeps this adapter on best-effort tmux delivery. */
    observeDraft?(capture: string, prompt: string): SubmissionDraftState;
    readonly interrupt: TmuxKey[];
    selectOption(index: number): TmuxKey[];
  };
  readonly turns?: {
    latestCompleted(capture: string): Turn | undefined;
    lastPrompt(capture: string): string | undefined;
    latestMessage(capture: string): string | undefined;
    failed(capture: string): boolean;
  };
  readonly questions?: {
    parse?(capture: string): InlineQuestion | undefined;
    pending?(workspace: string, paneId: string): Promise<InlineQuestion | undefined>;
  };
  readonly commands?: {
    /** prefer the runtime's effective command catalog when supported */
    readonly runtimeCatalog?: 'codex-app-server';
    /** the agent's own config/state directory (its skills root), resolved from injectable env roots */
    stateDirectory(env?: NodeJS.ProcessEnv): string;
    skillDirectories(workspace: string, stateDirectory: string): string[];
    slash(): PromptCommand[];
    skillInvocation(name: string): string;
  };
  readonly conversations?: {
    validId(id: string): boolean;
    /**
     * The pane's current Conversation. The pane's `pid` drives the `/proc`
     * fd-walk; its `cwd` (supplied only when unique among live panes) is the
     * privilege-free fallback a confined service uses when it cannot readlink
     * the pane's descriptors — the same pair `completion.baseline` reads.
     */
    discover?(pane: { pid: number; cwd?: string }): Promise<Conversation | undefined>;
    /**
     * The title of one already-known conversation (its id is unique), used when the
     * pane reports it through `@rac_session`. The pane's `cwd` is supplied for
     * Adapters (Claude) whose transcript is keyed by working directory; an Adapter
     * that finds its transcript by id alone (Codex) ignores it.
     */
    title?(id: string, cwd?: string): Promise<string | undefined>;
  };
  /**
   * Turn completion read from the agent's own structured event log rather than the
   * TUI (ADR 0002). Native Codex renders no `─ Worked for` footer, so `turns`
   * (a pure TUI-string parse) never observes a completion; the rollout's
   * `task_complete`/`turn_aborted` events are the authoritative signal instead.
   * `baseline` resolves the pane's rollout and snapshots its state *before* a turn
   * starts; `since` returns the newest terminal turn recorded in that same rollout
   * past the baseline — its answer for a completion. The pane's `pid` drives the
   * `/proc` fd-walk; its `cwd` (supplied only when unique among live panes) is the
   * privilege-free fallback a confined service uses when it cannot readlink a
   * sandboxed pane's descriptors. `baseline` returns `undefined` when no single
   * rollout resolves, at which point the console falls back to `turns`.
   */
  readonly completion?: {
    baseline(pane: { pid: number; cwd?: string }): Promise<CompletionBaseline | undefined>;
    since(baseline: CompletionBaseline): Promise<CompletionEvent | undefined>;
  };
  /**
   * Console-owned files this Adapter needs on disk (hook settings, sandbox policy).
   * At boot the console renders each into `<RAC_ADAPTER_FILES_DIR ?? .data/adapters>/
   * <kind>/<name>` (0644, rewritten every boot) and hands the absolute paths back
   * through `LaunchInput.files`. Both the paths inside the content and the file
   * paths themselves are named against `context.repoRoot` (host paths under the
   * bridge), so a bridge without a host repository leaves the kind unlaunchable.
   */
  readonly files?: (context: AdapterFileContext) => Record<string, string>;
  readonly sandbox?: {
    needs: { domains: string[]; statePaths: string[]; protectedPaths: string[]; secrets: string[] };
    policyRequired: boolean;
  };
  /**
   * Runtime-cleanup rules for this agent's panes and processes. `exclude` names
   * the panes the console never shows on the dashboard (OMX worker panes);
   * `classify`/`classifyProcess` recognise the stale runtime targets the Cleanup
   * screen offers. Every OMX/HUD-specific rule lives here rather than in
   * discovery or cleanup (ADR 0002). The console builds one immutable `PaneScan`
   * per cleanup pass and calls `classify`/`classifyProcess` once per pane/process
   * against it, so an Adapter may memoise derived sets keyed on the scan.
   */
  readonly panes?: {
    exclude(pane: Pane): boolean;
    classify(pane: Pane, scan: PaneScan): CleanupClassification | undefined;
    classifyProcess(process: HostProcess, scan: PaneScan): CleanupClassification | undefined;
  };
}

/**
 * One configured adapter program (config `adapters.<kind>`). The console launches
 * a kind by prepending `program` to the Adapter's own arguments and appending the
 * operator's `args`, merging the operator's `env` over the Adapter's. `launchable`
 * and `unavailableReason` come from the boot executable check (skipped under the
 * host bridge, where `program` is a host path the container cannot stat).
 */
export type AdapterLaunchConfig = { program: string; args: string[]; env: Record<string, string>; launchable: boolean; unavailableReason?: string };
/** The configured adapters, keyed by kind; absent entirely in the legacy (pre-`adapters`) configuration. */
export type AdapterConfigs = Partial<Record<AgentKind, AdapterLaunchConfig>>;

/**
 * The capability record the console derives per registered kind and publishes on
 * the Dashboard (ADR 0002). Presence of an optional capability object becomes a
 * boolean the web reads; the resolution logic itself never leaves the server.
 * `launchable` is config-gated (a configured, executable program), and `program`
 * / `unavailableReason` carry the configured path and the reason it cannot launch.
 */
export type AdapterCapability = {
  launchable: boolean;
  unavailableReason?: string;
  program?: string;
  stateSource: Adapter['stateSource'];
  turnCapture: boolean;
  bookmarks: boolean;
  inlineQuestions: boolean;
  commands: boolean;
  sandbox: boolean;
};
