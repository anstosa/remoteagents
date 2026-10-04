import { CodexHeadlessReviewRunner } from '../review-runs/codex-headless.js';
import { generatedReviewTourJsonSchema, parseGeneratedReviewTourResult, REVIEW_GENERATION_TIMEOUT_MS, ReviewTourError, type GeneratedReviewTour, type ReviewComparison, type ReviewTourCapability } from './contracts.js';

export interface ReviewTourGenerator {
  capability(): Promise<ReviewTourCapability>;
  generate(comparison: ReviewComparison, signal: AbortSignal): Promise<GeneratedReviewTour>;
}

// build explanation-only instructions
function generationPrompt(comparison: ReviewComparison): string {
  const changes = comparison.changes.map(change => ({ id: change.id, file: change.file, originalFile: change.originalFile, category: change.category, kind: change.kind, patch: change.patch }));
  return [
    'Create a narrated implementation-change tour for a human reviewer.',
    'Give the tour a concise, specific title naming the implementation change or outcome. Do not use a broad category label such as "Mobile layout" as the title.',
    'Explain mechanism, intent, dependencies, and the order in which the implementation fits together.',
    'Group related change IDs across files into logical steps. Assign every change ID exactly once.',
    'Do not perform code review. Do not produce findings, warnings, issues, recommendations, severity, verdicts, approval, rejection, patches, fixes, or commands.',
    'Use only the provided change IDs in changeIds. Return JSON matching the supplied schema.',
    `Scope: ${comparison.scope}; base: ${comparison.base}; tests included: ${comparison.includeTests}; docs included: ${comparison.includeDocs}.`,
    JSON.stringify({ changes })
  ].join('\n\n');
}

export class CodexExecReviewTourGenerator implements ReviewTourGenerator {
  private readonly runner: CodexHeadlessReviewRunner;

  // the Codex binary: an explicit override, else the configured adapters.codex program
  constructor(binary?: string) { this.runner = new CodexHeadlessReviewRunner(binary); }

  // verify the configured CLI surface once
  capability(): Promise<ReviewTourCapability> { return this.runner.capability() as Promise<ReviewTourCapability>; }

  // run one ephemeral structured generation
  async generate(comparison: ReviewComparison, signal: AbortSignal): Promise<GeneratedReviewTour> {
    const parsed = await this.runner.run({ kind: 'codex', workspace: comparison.workspace, prompt: generationPrompt(comparison), schema: generatedReviewTourJsonSchema, timeoutMs: REVIEW_GENERATION_TIMEOUT_MS, label: `Tour · ${comparison.branch ?? comparison.worktreeId}` }, signal);
    const result = parseGeneratedReviewTourResult(parsed, comparison.changes);
    // reject invalid assignments or narration
    if (!result.ok) throw new ReviewTourError(result.code, true);
    return result.tour;
  }
}
