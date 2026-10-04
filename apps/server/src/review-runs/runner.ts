import { ReviewTourError } from '../review-tour/contracts.js';
import type { ReviewAgentKind } from './efforts.js';

export type ReviewRunUnavailableReason = 'generator_unavailable' | 'unsupported_cli' | 'configuration_invalid' | 'authentication_required' | 'interactive_unavailable';
export type ReviewRunCapability = { available: true } | { available: false; reason: ReviewRunUnavailableReason };
// one Review run (ADR 0010): a prompt sent to one agent in the Worktree, answered with JSON
// matching `schema`. `label` names an interactive run's Agent ("Tour · branch"); headless
// runs ignore it. An absent model or effort leaves the CLI's own default. `maxOutputBytes`
// bounds the structured result, MAX_REVIEW_GENERATED_BYTES when absent.
export type ReviewRunRequest = { kind: ReviewAgentKind; workspace: string; prompt: string; schema: object; model?: string; effort?: string; timeoutMs: number; label: string; maxOutputBytes?: number };
export type ReviewRunErrorCode = 'capability_unavailable' | 'authentication_required' | 'generation_failed' | 'malformed_result' | 'timed_out' | 'cancelled';

// a typed Review run failure; a ReviewTourError, so tour and review jobs map it unchanged
export class ReviewRunError extends ReviewTourError {
  constructor(public override readonly code: ReviewRunErrorCode, retryable: boolean) { super(code, retryable); }
}

// runs Review runs of any kind; the caller validates the parsed JSON it returns
export interface ReviewRunner {
  capability(kind: ReviewAgentKind): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown>;
}

// runs one kind's Review runs (a headless CLI); routed to by kind and mode
export interface KindReviewRunner {
  capability(): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown>;
}

// refuse a run whose capability check failed; a missing CLI may yet be installed
export function unavailable(capability: ReviewRunCapability): ReviewRunError | undefined {
  return capability.available ? undefined : new ReviewRunError('capability_unavailable', capability.reason === 'generator_unavailable');
}
