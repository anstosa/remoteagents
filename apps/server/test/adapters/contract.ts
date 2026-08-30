/**
 * The Adapter contract, as much of it as the shared contract suite exercises.
 *
 * This lives in the test tree on purpose: chunk 1 commit 1 lands fixtures and
 * the suite *before* any Codex logic moves, so there is no production Adapter
 * interface yet. Commit 2 introduces the real interface and registry in `src`;
 * at that point this file and `codex-shim.ts` are deleted and the suite imports
 * the real types and registry unchanged (ADR 0002).
 */

export type AgentKind = 'codex' | 'claude' | 'pi' | 'opencode';
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter';

export type SubmissionMode = 'prompt' | 'shell';
export type Submission = { text: string; keys: TmuxKey[] };
export type Turn = { prompt?: string; text: string; rows?: number };

export interface AdapterContract {
  readonly kind: AgentKind;
  readonly stateSource: 'reported' | 'title' | 'both';
  recognizes(process: { comm: string; argv: string[] }): boolean;
  /** `undefined` when the title carries no signal. */
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
  readonly conversations?: { validId(id: string): boolean };
}
