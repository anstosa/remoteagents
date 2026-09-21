import type { Worktree } from '../domain/models.js';
import {
  addUntrackedLineStats, captureComparisonPatch, fileAtRevision, prComparisonCandidates, resolveComparison,
  type ComparisonFailure, type ComparisonKind, type ComparisonPatch,
  type PatchLimits, type RevisionFile
} from './comparison.js';

// caps for a Code-panel patch capture: the per-file byte cap matches the file-preview /
// file-at-revision 256 KB envelope, and the total and file-count caps keep a whole-Comparison
// capture bounded so opening a review can never stream an unbounded diff into the browser
export const DEFAULT_COMPARISON_PATCH_LIMITS: PatchLimits = { perFileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, maxFiles: 256 };

// resolve one Worktree's All PR base (the dashboard's already-resolved merge target), or undefined
// when none is known — see workspaces/resolver.worktreePrBase, the single reader of that base
export type PreferredBaseResolver = (worktreeId: string) => Promise<string | undefined>;

export type ComparisonPatchResult =
  | { ok: true; kind: ComparisonKind; patch: ComparisonPatch }
  | { ok: false; reason: ComparisonFailure };

// a changed file's two sides: its contents at the Comparison base (the old side; a rename reads
// its origin) and at the working tree (the new side). Either side is absent for an add or delete.
export type ComparisonFileResult =
  | { ok: true; path: string; base?: RevisionFile; working?: RevisionFile }
  | { ok: false; reason: ComparisonFailure | 'not_in_comparison' };

// Serve the Code panel's two worktree-scoped reads on top of the shared comparison module: the
// per-file patch for a whole Comparison (with its fingerprint and size-cap markers), and one
// changed file's base + working contents for context expansion. The All PR base is supplied by an
// injected resolver so this composition stays independent of discovery / the dashboard shape.
export class ComparisonService {
  constructor(
    private readonly preferredBase: PreferredBaseResolver,
    private readonly limits: PatchLimits = DEFAULT_COMPARISON_PATCH_LIMITS
  ) {}

  async patch(worktree: Worktree, kind: ComparisonKind): Promise<ComparisonPatchResult> {
    const result = await this.resolve(worktree, kind);
    // map the module's failure reasons straight through; the route turns them into a 404
    if (!result.ok) return { ok: false, reason: result.reason };
    // Enrich untracked line counts before fingerprinting: workingStatus's numstat lineStats cover
    // tracked files only, so without this a size-capped untracked file (patch withheld) would fold
    // nothing content-varying into the fingerprint and an in-place edit of it would go undetected.
    // Pass the resolved `changes` explicitly — for a Working Comparison it is the same array as
    // `status.changes`, but an All PR Comparison copies untracked entries into `changes`, so the
    // fingerprint (which reads `changes`) only moves when those copies are the ones mutated.
    await addUntrackedLineStats(worktree.identity, { ...result.comparison.status, changes: result.comparison.changes });
    const patch = await captureComparisonPatch(worktree.identity, result.comparison, this.limits);
    return { ok: true, kind, patch };
  }

  async file(worktree: Worktree, kind: ComparisonKind, path: string): Promise<ComparisonFileResult> {
    const result = await this.resolve(worktree, kind);
    if (!result.ok) return { ok: false, reason: result.reason };
    const comparison = result.comparison;
    // security-F2: pin caller input to the resolved Comparison. Allow-list the requested path to a
    // Change (its current path, else a rename origin) rather than reading an arbitrary working-tree
    // path, and derive the base commit from the Comparison — the client never chooses a revision.
    // Prefer the exact current-path match so a new file at a rename's vacated origin is not shadowed.
    const change = comparison.changes.find(candidate => candidate.path === path) ?? comparison.changes.find(candidate => candidate.originalPath === path);
    if (change === undefined) return { ok: false, reason: 'not_in_comparison' };
    // the base side reads the rename origin when present; the working side always reads the current path
    const [base, working] = await Promise.all([
      fileAtRevision(worktree.identity, { commit: comparison.gitBase }, change.originalPath ?? change.path),
      fileAtRevision(worktree.identity, { workingTree: true }, change.path)
    ]);
    return { ok: true, path, ...(base === undefined ? {} : { base }), ...(working === undefined ? {} : { working }) };
  }

  // resolve a Comparison for one worktree; Working folds HEAD vs the working tree, All PR compares
  // the resolved merge target (falling back to the full base-candidate ladder). lineStats is always
  // on so an edit inside a size-capped file still moves the fingerprint.
  private async resolve(worktree: Worktree, kind: ComparisonKind) {
    if (kind !== 'pr') return resolveComparison(worktree.identity, kind, [], { lineStats: true });
    const preferred = await this.preferredBase(worktree.id);
    // the resolved base is already a full ref label — pass it straight through (like the Review tour),
    // never back through the candidate ladder, which would re-prefix a non-origin base such as
    // `upstream/trunk`. Fall back to the full ladder only when no base was resolved.
    const candidates = preferred !== undefined ? [preferred] : await prComparisonCandidates(worktree.identity, worktree.branch, undefined, false);
    return resolveComparison(worktree.identity, kind, candidates, { lineStats: true });
  }
}
