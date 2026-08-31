/**
 * The Adapter interface: every agent CLI the console knows is described by one
 * Adapter (ADR 0002). An Adapter *describes* its agent — how to recognise its
 * processes, what its title says, how a prompt is submitted — while the console
 * performs every side effect through its single tmux and `/proc` layer.
 *
 * Chunk 1 populates only `kind`, `stateSource`, `recognizes`, `inferState` and
 * `submission` (plus Codex's existing `turns`/`conversations`, carried as
 * facades). The remaining optional capabilities are declared here so the derived
 * capability record can read their presence; later chunks fill them in.
 */

export const agentKinds = ['codex', 'claude', 'pi', 'opencode'] as const;   // closed union; the registry is code, not plugins
export type AgentKind = typeof agentKinds[number];
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter';

export type SubmissionMode = 'prompt' | 'shell';
export type Submission = { text: string; keys: TmuxKey[] };
export type Conversation = { id: string; title?: string };
export type Turn = { prompt?: string; text: string; rows?: number };
export type InlineQuestion = { id: string; text: string; choices: string[]; source: 'structured' | 'parsed'; targetPaneId?: string };
export type PromptCommand = { name: string; description?: string };
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
  /** Classify one process by its own identity; the wrapper ancestor is the walker's concern. */
  recognizes(process: { comm: string; argv: string[] }): boolean;
  /** The title-derived Attention state, or `undefined` when the title carries no signal. */
  inferState(pane: { title: string; command?: string }): AttentionState | undefined;
  readonly submission: {
    prepare(prompt: string, mode: SubmissionMode): Submission;
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
    skillDirectories(workspace: string, home: string): string[];
    readonly slash: PromptCommand[];
    skillInvocation(name: string): string;
  };
  readonly conversations?: {
    validId(id: string): boolean;
    discover?(pid: number): Promise<Conversation | undefined>;
    /** The title of one already-known conversation (its id is unique), used when the pane reports it through `@rac_session`. */
    title?(id: string): Promise<string | undefined>;
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
  readonly sandbox?: {
    needs: { domains: string[]; statePaths: string[]; protectedPaths: string[]; secrets: string[] };
    policyRequired: boolean;
  };
}

/**
 * The capability record the console derives per registered kind and publishes on
 * the Dashboard (ADR 0002). Presence of an optional capability object becomes a
 * boolean the web reads; the resolution logic itself never leaves the server.
 */
export type AdapterCapability = {
  launchable: boolean;
  stateSource: Adapter['stateSource'];
  turnCapture: boolean;
  bookmarks: boolean;
  inlineQuestions: boolean;
  commands: boolean;
  sandbox: boolean;
};
