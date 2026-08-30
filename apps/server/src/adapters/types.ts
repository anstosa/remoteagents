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

export type AgentKind = 'codex' | 'claude' | 'pi' | 'opencode';   // closed union; the registry is code, not plugins
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter';

export type SubmissionMode = 'prompt' | 'shell';
export type Submission = { text: string; keys: TmuxKey[] };
export type Turn = { prompt?: string; text: string; rows?: number };
export type InlineQuestion = { id: string; text: string; choices: string[]; source: 'structured' | 'parsed'; targetPaneId?: string };
export type PromptCommand = { name: string; description?: string };

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
    discover?(pid: number): Promise<{ id: string; title?: string } | undefined>;
    title?(id: string, cwd: string): Promise<string | undefined>;
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
