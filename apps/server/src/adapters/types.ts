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

export const agentKinds = ['codex', 'omx', 'claude', 'pi', 'opencode'] as const;   // closed union in resolution order; the registry is code, not plugins
export type AgentKind = typeof agentKinds[number];
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter';

export type SubmissionMode = 'prompt' | 'shell';
export type SubmissionDraftState = 'visible' | 'cleared' | 'unknown';
// `keys` queues behind active work; `idleKeys` may use the Agent's direct submit path
export type Submission = { text: string; keys: TmuxKey[]; idleKeys?: TmuxKey[] };
export type Conversation = { id: string; title?: string };
/**
 * One Named conversation an Adapter's `list` returns: its id, the Conversation
 * name, whether that name is automatic where the kind can tell (Claude, Pi;
 * omitted for Codex), the agent-derived last-active time (epoch ms, never the
 * file mtime), and the directory it was started in.
 */
export type ConversationSummary = { id: string; name: string; automatic?: boolean; lastActiveAt: number; directory: string };
/** The pure tmux delivery for a CLI's own rename command: paste `text`, then send `keys`. */
export type ConversationRename = { text: string; keys: TmuxKey[] };
/** codex and omx share one rollout store (ADR 0005), so their Conversations are one family. */
export const codexFamily = (kind: AgentKind): boolean => kind === 'codex' || kind === 'omx';
/**
 * Whether two Conversation references name the same Conversation: equal ids and matching kinds,
 * treating codex and omx as one (ADR 0005), so a rollout resumed or named under either wrapper is
 * the same Conversation.
 */
export const sameConversation = (left: { kind: AgentKind; id: string }, right: { kind: AgentKind; id: string }): boolean =>
  left.id === right.id && (codexFamily(left.kind) ? codexFamily(right.kind) : left.kind === right.kind);
export type Turn = { prompt?: string; text: string; rows?: number };
// `source` is the web's dismissal-strategy discriminator, not the transport: a
// `parsed` question the client may optimistically dismiss, a `structured` one (OMX's
// file, Claude's reported payload) is server-published and waits for the server to
// stop reporting it. Not the same as the CONTEXT.md "Inline question" provenance.
// selectedIndex is the live zero-based keyboard cursor, not part of the question id
export type InlineQuestion = { id: string; text: string; choices: string[]; source: 'structured' | 'parsed'; targetPaneId?: string; selectedIndex?: number };
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
 * tmux or `/proc` knowledge (ADR 0002). The rules themselves live in each
 * Adapter — the worker/HUD rules in the OMX Adapter, the stale-Codex rule in the
 * Codex Adapter; the console only supplies the pane set, the process tree, and
 * the generic derivations (`identity`, `active`, `recognizedKind`, `excluded`,
 * `paneAncestor`).
 */
export type PaneScan = {
  panes: readonly Pane[];
  processes: readonly HostProcess[];
  identity(pane: Pane): string;
  sessionIdentity(pane: Pane): string;
  active(pane: Pane): boolean;
  recognizedKind(pane: Pane): AgentKind | undefined;
  /**
   * Whether any registered Adapter hides this pane from the dashboard (its own
   * `panes.exclude`), so one kind's rules never call another kind's hidden pane a
   * stale agent — a Codex rule need not know OMX's worker paths.
   */
  excluded(pane: Pane): boolean;
  paneAncestor(pid: number): Pane | undefined;
};
/** One runtime-cleanup classification an Adapter emits; the console wraps it with a stable id. */
export type CleanupClassification = Pick<CleanupTarget, 'kind' | 'label' | 'detail'>;
/** The pane's human-readable name for a cleanup classification's detail line. */
export const paneLabel = (pane: Pane): string => pane.displayLabel || pane.title || pane.sessionName || pane.paneId;
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
    /**
     * A prompt that completes without ever reporting `working` — an instant
     * conversation-control command like Claude's `/clear`, which returns straight
     * to an idle composer with no model turn. The console must not open an
     * awaiting-start phase for it: that phase would wait for a `working` report
     * that never comes, time out, and sweep any queued follow-up into saved
     * prompts. Absent (or `false`) keeps the normal tracked-completion path.
     */
    completesWithoutWork?(prompt: string): boolean;
    readonly interrupt: TmuxKey[];
    /** navigate from the freshly observed cursor when the question provides one */
    selectOption(index: number, selectedIndex?: number): TmuxKey[];
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
    /**
     * The Inline question an Agent reported on its own pane (`@rac_question`),
     * confirmed live against the pane's capture (ADR 0006). Pure: the base64 hook
     * payload and the capture in, one question out. A call carrying several
     * questions is walked one tab at a time — the single question drawn on screen,
     * then a Submit answers / Cancel step at its review page. `undefined` when the
     * payload is unrenderable (multiSelect, no options), when no question is on
     * screen (cancelled or already answered), or when the on-screen tab is
     * indistinguishable (two questions sharing a text and first option).
     */
    reported?(payload: string, capture: string): InlineQuestion | undefined;
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
    /**
     * Whether `id` is a well-formed Conversation id for this kind. The console
     * interpolates a resumed id into the host launch command, so this MUST reject
     * any id that is not safe to place there unquoted (both current implementations
     * are strict anchored UUID patterns); the resume path relies on it in place of a
     * hard-coded pattern.
     */
    validId(id: string): boolean;
    /**
     * The pane's current Conversation. The pane's `pid` drives the `/proc`
     * fd-walk; its `cwd` (supplied only when unique among live panes) is the
     * privilege-free fallback a confined service uses when it cannot readlink
     * the pane's descriptors — the same pair `completion.baseline` reads.
     */
    discover?(pane: { pid: number; cwd?: string }): Promise<Conversation | undefined>;
    /**
     * The Named conversations under the given directories, newest-first — only
     * Conversations that carry a Conversation name. `directory` is the one each was
     * started in, matched exactly as the agents' own pickers do. Later chunks fill
     * this in per kind; a kind that lists must also implement `readName`.
     */
    list?(directories: readonly string[]): Promise<ConversationSummary[]>;
    /**
     * The pure tmux delivery for the CLI's own rename command (Claude `/rename`,
     * Codex/OMX `/rename ` with a trailing space): the console pastes `text` and
     * sends `keys` on the pane. `keys` is `['Enter']` in every Attention state.
     */
    rename?(name: string): ConversationRename;
    /**
     * The Conversation's current name, read from the agent's own store by id — the
     * read-back after a console rename, and the name `discovery.conversation` reads
     * for a pane. The pane's `cwd` is supplied for Adapters (Claude) whose transcript is
     * keyed by working directory; an Adapter that finds its store by id alone
     * (Codex) ignores it. `undefined` when the Conversation has no name, or on any
     * read error — an unknown id, an unknown cwd, or an unreadable/absent store.
     */
    readName?(id: string, cwd?: string): Promise<string | undefined>;
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
   * the panes the console never shows on the dashboard (the OMX Adapter's worker
   * panes); `classify`/`classifyProcess` recognise the stale runtime targets the
   * Cleanup screen offers. Every agent-specific rule lives in its own Adapter
   * rather than in discovery or cleanup (ADR 0002); a kind that hides no panes or
   * runs no helper processes simply omits `exclude`/`classifyProcess`. The console
   * builds one immutable `PaneScan` per cleanup pass and calls `classify`/
   * `classifyProcess` once per pane/process against it — in registry order, first
   * classification wins — so an Adapter may memoise derived sets keyed on the scan.
   */
  readonly panes?: {
    exclude?(pane: Pane): boolean;
    classify(pane: Pane, scan: PaneScan): CleanupClassification | undefined;
    classifyProcess?(process: HostProcess, scan: PaneScan): CleanupClassification | undefined;
  };
}

/**
 * One configured adapter program (config `adapters.<kind>`). The console launches
 * a kind by prepending `program` to the Adapter's own arguments and appending the
 * operator's `args`, merging the operator's `env` over the Adapter's. `launchable`
 * and `unavailableReason` come from the boot executable check (skipped under the
 * host bridge, where `program` is a host path the container cannot stat).
 * `setup` runs in the launched pane before the program (a failure aborts the
 * launch); `teardown` runs best-effort in the agent's workspace after a stop.
 */
/** Trusted shell commands used to inspect and update one configured agent CLI. */
export type AdapterUpdateCommands = { current: string; latest: string; run: string };
export type AdapterLaunchConfig = { program: string; args: string[]; env: Record<string, string>; launchable: boolean; unavailableReason?: string; setup?: string; teardown?: string; updates?: AdapterUpdateCommands };
/** The configured adapters, keyed by kind; empty for an observe-only console. */
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
  /** the Adapter lists its Named conversations (`conversations.list` present) */
  conversations: boolean;
  /** the Adapter renames a Conversation from the console (`conversations.rename` present) */
  naming: boolean;
  inlineQuestions: boolean;
  commands: boolean;
  sandbox: boolean;
};
