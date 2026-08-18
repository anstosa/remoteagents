import { z } from 'zod';
import type { ReviewCategory } from '../git/change-classification.js';

export const REVIEW_REQUEST_BODY_BYTES = 1_024;
export const MAX_REVIEW_FILES = 100;
export const MAX_REVIEW_CHANGES = 500;
export const MAX_REVIEW_DIFF_BYTES = 900_000;
export const MAX_REVIEW_FILE_BYTES = 160_000;
export const MAX_REVIEW_GENERATED_BYTES = 96_000;
export const REVIEW_GENERATION_TIMEOUT_MS = 120_000;
export const REVIEW_JOB_TTL_MS = 300_000;
export const REVIEW_JOB_POLL_MS = 1_000;

export type ReviewScope = 'working' | 'pr';
export type ReviewChangeKind = 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked';
export type ReviewChange = {
  id: string;
  file: string;
  originalFile?: string;
  category: ReviewCategory;
  kind: ReviewChangeKind;
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  patch: string;
};
export type ReviewSnapshot = {
  agentId: string;
  worktreeId: string;
  workspace: string;
  branch?: string;
  scope: ReviewScope;
  base: string;
  includeTests: boolean;
  includeDocs: boolean;
  fingerprint: string;
  changes: ReviewChange[];
};
export type GeneratedReviewStep = { id: string; title: string; explanation: string; changeIds: string[] };
export type GeneratedReviewTour = { title: string; overview: string; steps: GeneratedReviewStep[] };
export type ReviewTour = GeneratedReviewTour & Pick<ReviewSnapshot, 'scope' | 'base' | 'includeTests' | 'includeDocs' | 'fingerprint' | 'changes'>;
export type ReviewTourInput = { scope: ReviewScope; includeTests: boolean; includeDocs: boolean };
export type ReviewTourCapability = { available: true } | { available: false; reason: 'generator_unavailable' | 'unsupported_cli' | 'configuration_invalid' | 'authentication_required' };
export type StoredReviewTour = { worktreeId: string; branch: string; savedAt: string; tour: ReviewTour };
export type StoredReviewTourSummary = Pick<StoredReviewTour, 'worktreeId' | 'branch' | 'savedAt'> & Pick<ReviewTour, 'title' | 'scope' | 'includeTests' | 'includeDocs' | 'fingerprint'>;
export type ReviewErrorCode = 'invalid_request' | 'capability_unavailable' | 'authentication_required' | 'target_unavailable' | 'configured_worktree_required' | 'scope_unavailable' | 'conflicted_unavailable' | 'too_large' | 'generation_failed' | 'malformed_result' | 'generation_rejected' | 'timed_out' | 'cancelled' | 'stale_during_generation';
export type PublicReviewSnapshot = Pick<ReviewSnapshot, 'scope' | 'base' | 'fingerprint' | 'includeTests' | 'includeDocs'>;

export class ReviewTourError extends Error {
  // retain typed review failures
  constructor(public readonly code: ReviewErrorCode, public readonly retryable: boolean) { super(code); }
}

const inputSchema = z.object({ scope: z.enum(['working', 'pr']), includeTests: z.boolean(), includeDocs: z.boolean() }).strict();
const generatedStepSchema = z.object({ id: z.string().min(1).max(80), title: z.string().trim().min(1).max(240), explanation: z.string().trim().min(1).max(4_000), changeIds: z.array(z.string().min(8).max(100)).min(1).max(MAX_REVIEW_CHANGES) }).strict();
const generatedTourSchema = z.object({ title: z.string().trim().min(1).max(240), overview: z.string().trim().min(1).max(2_000), steps: z.array(generatedStepSchema).min(1).max(MAX_REVIEW_CHANGES) }).strict();
const reviewChangeSchema = z.object({ id: z.string().min(8).max(100), file: z.string().min(1).max(4_096), originalFile: z.string().min(1).max(4_096).optional(), category: z.enum(['implementation', 'test', 'doc']), kind: z.enum(['hunk', 'binary', 'rename', 'metadata', 'untracked']), oldStart: z.number().int().nonnegative().optional(), oldLines: z.number().int().nonnegative().optional(), newStart: z.number().int().nonnegative().optional(), newLines: z.number().int().nonnegative().optional(), patch: z.string().max(MAX_REVIEW_FILE_BYTES) }).strict();
const reviewTourSchema = generatedTourSchema.extend({ scope: z.enum(['working', 'pr']), base: z.string().min(1).max(4_096), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), changes: z.array(reviewChangeSchema).min(1).max(MAX_REVIEW_CHANGES) }).strict();
const prohibitedPrefix = /^(?:finding|findings|warning|warnings|issue|issues|recommendation|recommendations|severity|verdict|approval|approved|rejection|rejected)\s*[:\-–—]/iu;

// parse the fixed review request
export function parseReviewTourInput(value: unknown): ReviewTourInput | undefined {
  const parsed = inputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// reject finding-shaped narration labels
export function prohibitedNarration(value: string): boolean {
  return prohibitedPrefix.test(value.trim().normalize('NFKC'));
}

export type GeneratedReviewTourParseResult = { ok: true; tour: GeneratedReviewTour } | { ok: false; code: 'malformed_result' | 'generation_rejected' };

// validate model output and exact assignments
export function parseGeneratedReviewTourResult(value: unknown, changes: ReviewChange[]): GeneratedReviewTourParseResult {
  const parsed = generatedTourSchema.safeParse(value);
  // require structural validity
  if (!parsed.success) return { ok: false, code: 'malformed_result' };
  const tour = parsed.data;
  const narration = [tour.title, tour.overview, ...tour.steps.flatMap(step => [step.title, step.explanation])];
  // reject explicit review labels
  if (narration.some(prohibitedNarration)) return { ok: false, code: 'generation_rejected' };
  const expected = new Set(changes.map(change => change.id));
  const assigned = new Set<string>();
  // validate every model reference
  for (const step of tour.steps) {
    // require unique step ids
    if (tour.steps.filter(candidate => candidate.id === step.id).length !== 1) return { ok: false, code: 'malformed_result' };
    // validate change assignments
    for (const id of step.changeIds) {
      // reject unknown or duplicate ids
      if (!expected.has(id) || assigned.has(id)) return { ok: false, code: 'malformed_result' };
      assigned.add(id);
    }
  }
  // require complete coverage
  if (assigned.size !== expected.size) return { ok: false, code: 'malformed_result' };
  return { ok: true, tour };
}

// retain the simple parser for trusted callers
export function parseGeneratedReviewTour(value: unknown, changes: ReviewChange[]): GeneratedReviewTour | undefined {
  const result = parseGeneratedReviewTourResult(value, changes);
  return result.ok ? result.tour : undefined;
}

// validate a complete persisted tour
export function parseReviewTour(value: unknown): ReviewTour | undefined {
  const parsed = reviewTourSchema.safeParse(value);
  // require the complete bounded shape
  if (!parsed.success) return undefined;
  const tour = parsed.data;
  const patchBytes = tour.changes.reduce((total, change) => total + Buffer.byteLength(change.patch), 0);
  // enforce the canonical aggregate boundary
  if (patchBytes > MAX_REVIEW_DIFF_BYTES) return undefined;
  const generated = parseGeneratedReviewTour({ title: tour.title, overview: tour.overview, steps: tour.steps }, tour.changes);
  // retain only exact change assignments
  return generated === undefined ? undefined : { ...generated, scope: tour.scope, base: tour.base, includeTests: tour.includeTests, includeDocs: tour.includeDocs, fingerprint: tour.fingerprint, changes: tour.changes };
}

// expose only snapshot identity fields
export function publicReviewSnapshot(snapshot: ReviewSnapshot): PublicReviewSnapshot {
  return { scope: snapshot.scope, base: snapshot.base, fingerprint: snapshot.fingerprint, includeTests: snapshot.includeTests, includeDocs: snapshot.includeDocs };
}

export const generatedReviewTourJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'overview', 'steps'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 240 },
    overview: { type: 'string', minLength: 1, maxLength: 2_000 },
    steps: { type: 'array', minItems: 1, maxItems: MAX_REVIEW_CHANGES, items: {
      type: 'object', additionalProperties: false, required: ['id', 'title', 'explanation', 'changeIds'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        title: { type: 'string', minLength: 1, maxLength: 240 },
        explanation: { type: 'string', minLength: 1, maxLength: 4_000 },
        changeIds: { type: 'array', minItems: 1, maxItems: MAX_REVIEW_CHANGES, items: { type: 'string', minLength: 8, maxLength: 100 } }
      }
    } }
  }
} as const;
