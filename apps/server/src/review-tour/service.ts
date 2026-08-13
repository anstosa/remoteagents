import type { DiscoveryService } from '../discovery/service.js';
import type { Worktree } from '../domain/models.js';
import { resolveConfiguredWorkspace, sameConfiguredWorkspace, type ResolvedWorkspace } from '../workspaces/resolver.js';
import { captureReviewSnapshot } from './diff.js';
import type { ReviewTourGenerator } from './generator.js';
import { publicReviewSnapshot, ReviewTourError, type PublicReviewSnapshot, type ReviewSnapshot, type ReviewTour, type ReviewTourCapability, type ReviewTourInput } from './contracts.js';

export type PreparedReviewTour = { resolved: ResolvedWorkspace; snapshot: ReviewSnapshot };

export class ReviewTourService {
  constructor(private readonly discovery: DiscoveryService, private readonly worktrees: Worktree[], private readonly generator: ReviewTourGenerator) {}

  // expose the bounded generator capability
  capability(): Promise<ReviewTourCapability> { return this.generator.capability(); }

  // capture a validated generation input
  async prepare(agentId: string, input: ReviewTourInput): Promise<PreparedReviewTour> {
    const capability = await this.capability();
    // fail closed without generation support
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    const target = await this.discovery.target(agentId);
    // distinguish missing and unconfigured targets
    if (target === undefined) throw new ReviewTourError('target_unavailable', true);
    const resolved = await resolveConfiguredWorkspace(this.discovery, this.worktrees, agentId);
    // require a configured active agent
    if (resolved === undefined) throw new ReviewTourError('configured_worktree_required', false);
    const snapshot = await captureReviewSnapshot(resolved, input);
    // reject identity changes during capture
    if (!await sameConfiguredWorkspace(this.discovery, this.worktrees, agentId, resolved)) throw new ReviewTourError('target_unavailable', true);
    return { resolved, snapshot };
  }

  // generate and revalidate one complete tour
  async generate(prepared: PreparedReviewTour, signal: AbortSignal): Promise<ReviewTour> {
    const generated = await this.generator.generate(prepared.snapshot, signal);
    // preserve caller cancellation
    if (signal.aborted) throw new ReviewTourError('cancelled', true);
    const current = await captureReviewSnapshot(prepared.resolved, { scope: prepared.snapshot.scope, includeTests: prepared.snapshot.includeTests, includeDocs: prepared.snapshot.includeDocs });
    // reject stale narration before publication
    if (current.fingerprint !== prepared.snapshot.fingerprint || current.branch !== prepared.snapshot.branch) throw new ReviewTourError('stale_during_generation', true);
    // reject agent replacement before publication
    if (!await sameConfiguredWorkspace(this.discovery, this.worktrees, prepared.snapshot.agentId, prepared.resolved)) throw new ReviewTourError('target_unavailable', true);
    return { ...generated, scope: prepared.snapshot.scope, base: prepared.snapshot.base, includeTests: prepared.snapshot.includeTests, includeDocs: prepared.snapshot.includeDocs, fingerprint: prepared.snapshot.fingerprint, changes: prepared.snapshot.changes };
  }

  // recompute current source identity without generation
  async fingerprint(agentId: string, input: ReviewTourInput): Promise<{ snapshot: PublicReviewSnapshot; empty: boolean }> {
    const target = await this.discovery.target(agentId);
    // distinguish missing and unconfigured targets
    if (target === undefined) throw new ReviewTourError('target_unavailable', true);
    const resolved = await resolveConfiguredWorkspace(this.discovery, this.worktrees, agentId);
    // require a configured active agent
    if (resolved === undefined) throw new ReviewTourError('configured_worktree_required', false);
    const snapshot = await captureReviewSnapshot(resolved, input);
    return { snapshot: publicReviewSnapshot(snapshot), empty: snapshot.changes.length === 0 };
  }
}
