import { randomBytes } from 'node:crypto';
import { publicReviewSnapshot, REVIEW_JOB_POLL_MS, REVIEW_JOB_TTL_MS, ReviewTourError, type PublicReviewSnapshot, type ReviewErrorCode, type ReviewTour, type ReviewTourInput } from './contracts.js';
import type { PreparedReviewTour, ReviewTourService } from './service.js';
import type { ReviewTourStore } from './store.js';

type PendingJob = { kind: 'pending'; controller: AbortController };
type ReadyJob = { kind: 'ready'; tour: ReviewTour };
type EmptyJob = { kind: 'empty'; snapshot: PublicReviewSnapshot };
type FailedJob = { kind: 'error'; code: ReviewErrorCode; retryable: boolean };
type GoneJob = { kind: 'gone'; code: 'job_cancelled' | 'job_superseded' | 'job_expired' };
export type ReviewJobState = PendingJob | ReadyJob | EmptyJob | FailedJob | GoneJob;
export type StoredReviewJob = { id: string; owner: string; agentId: string; worktreeId: string; persistenceVersion: number; expiresAt: number; state: ReviewJobState; expiry: NodeJS.Timeout; removal?: NodeJS.Timeout };
export type StartedReviewJob = { id: string; expiresAt: string; retryAfterMs: number };

export class ReviewTourJobs {
  private readonly jobs = new Map<string, StoredReviewJob>();
  private readonly latestByWorktree = new Map<string, string>();
  private readonly persistenceVersions = new Map<string, number>();

  constructor(private readonly service: ReviewTourService, private readonly store?: ReviewTourStore, private readonly onStored?: () => void | Promise<void>) {}

  // start one latest-wins generation
  async start(owner: string, agentId: string, input: ReviewTourInput): Promise<{ kind: 'empty'; snapshot: PublicReviewSnapshot } | { kind: 'pending'; job: StartedReviewJob }> {
    const prepared = await this.service.prepare(agentId, input);
    const storeWithCurrency = this.store as (ReviewTourStore & { invalidate?: ReviewTourStore['invalidate']; saveIfCurrent?: ReviewTourStore['saveIfCurrent'] }) | undefined;
    const persistenceVersion = await storeWithCurrency?.invalidate?.(prepared.snapshot.worktreeId, prepared.snapshot.branch) ?? (this.persistenceVersions.get(prepared.snapshot.worktreeId) ?? 0) + 1;
    this.persistenceVersions.set(prepared.snapshot.worktreeId, persistenceVersion);
    this.supersede(owner, prepared);
    // skip model generation for empty selections
    if (prepared.snapshot.changes.length === 0) return { kind: 'empty', snapshot: publicReviewSnapshot(prepared.snapshot) };
    const id = randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + REVIEW_JOB_TTL_MS;
    const controller = new AbortController();
    const job: StoredReviewJob = { id, owner, agentId, worktreeId: prepared.snapshot.worktreeId, persistenceVersion, expiresAt, state: { kind: 'pending', controller }, expiry: setTimeout(() => this.expire(id), REVIEW_JOB_TTL_MS) };
    job.expiry.unref?.();
    this.jobs.set(id, job);
    this.latestByWorktree.set(this.latestKey(owner, job.worktreeId), id);
    void this.run(job, prepared);
    return { kind: 'pending', job: { id, expiresAt: new Date(expiresAt).toISOString(), retryAfterMs: REVIEW_JOB_POLL_MS } };
  }

  // publish a terminal generation result
  private async run(job: StoredReviewJob, prepared: PreparedReviewTour): Promise<void> {
    try {
      const tour = await this.service.generate(prepared, (job.state as PendingJob).controller.signal);
      const current = this.jobs.get(job.id);
      // ignore superseded completions
      if (current !== job || current.state.kind !== 'pending') return;
      // durably retain branch-bound completed tours
      if (this.store !== undefined && prepared.snapshot.branch !== undefined) {
        const storeWithCurrency = this.store as ReviewTourStore & { saveIfCurrent?: ReviewTourStore['saveIfCurrent'] };
        const conditionalSave = storeWithCurrency?.saveIfCurrent;
        // preserve simple injected stores while production uses atomic currency
        const stored = conditionalSave === undefined
          ? await this.store.save(prepared.snapshot.worktreeId, prepared.snapshot.branch, tour)
          : await conditionalSave.call(this.store, prepared.snapshot.worktreeId, prepared.snapshot.branch, tour, job.persistenceVersion);
        // require persistence when a store is configured
        if (stored === undefined) throw new ReviewTourError('generation_failed', true);
        // discard superseded persistence attempts
        if (stored === false) { this.markGone(job, 'job_superseded'); return; }
      }
      const retained = this.jobs.get(job.id);
      // ignore jobs superseded during persistence
      if (retained !== job || retained.state.kind !== 'pending') return;
      retained.state = { kind: 'ready', tour };
      // publish the new footer state
      await this.onStored?.();
    } catch (error) {
      const current = this.jobs.get(job.id);
      // ignore cancelled or removed jobs
      if (current !== job || current.state.kind !== 'pending') return;
      const typed = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
      current.state = { kind: 'error', code: typed.code, retryable: typed.retryable };
    }
  }

  // cancel earlier worktree generation
  private supersede(owner: string, prepared: PreparedReviewTour): void {
    const previousId = this.latestByWorktree.get(this.latestKey(owner, prepared.snapshot.worktreeId));
    const previous = previousId === undefined ? undefined : this.jobs.get(previousId);
    // retain an owner-scoped superseded tombstone
    if (previous !== undefined) this.markGone(previous, 'job_superseded');
  }

  // read an owner-scoped job
  get(owner: string, id: string): StoredReviewJob | undefined {
    const job = this.jobs.get(id);
    // hide cross-owner identifiers
    return job?.owner === owner ? job : undefined;
  }

  // cancel an owner-scoped job
  cancel(owner: string, id: string): boolean {
    const job = this.get(owner, id);
    // reject unknown jobs
    if (job === undefined) return false;
    this.markGone(job, 'job_cancelled');
    return true;
  }

  // expire private job results
  private expire(id: string): void {
    const job = this.jobs.get(id);
    // ignore removed jobs
    if (job === undefined) return;
    this.markGone(job, 'job_expired');
    job.removal = setTimeout(() => this.remove(id), 60_000);
    job.removal.unref?.();
  }

  // retain only a bounded gone marker
  private markGone(job: StoredReviewJob, code: GoneJob['code']): void {
    // abort active generation
    if (job.state.kind === 'pending') {
      job.state.controller.abort();
      // serialize cancellation behind any active persistence
      const conditionalStore = this.store as (ReviewTourStore & { invalidateIfCurrent?: ReviewTourStore['invalidateIfCurrent'] }) | undefined;
      void conditionalStore?.invalidateIfCurrent?.(job.worktreeId, job.persistenceVersion).catch(() => undefined);
    }
    job.state = { kind: 'gone', code };
    // clear latest ownership
    const latestKey = this.latestKey(job.owner, job.worktreeId);
    if (this.latestByWorktree.get(latestKey) === job.id) this.latestByWorktree.delete(latestKey);
  }

  // remove one stored job
  private remove(id: string): void {
    const job = this.jobs.get(id);
    // clear active resources
    if (job?.state.kind === 'pending') job.state.controller.abort();
    if (job !== undefined) {
      clearTimeout(job.expiry);
      if (job.removal !== undefined) clearTimeout(job.removal);
      const latestKey = this.latestKey(job.owner, job.worktreeId);
      if (this.latestByWorktree.get(latestKey) === id) this.latestByWorktree.delete(latestKey);
    }
    this.jobs.delete(id);
  }

  // stop every pending generation
  close(): void {
    // remove all jobs
    for (const id of [...this.jobs.keys()]) this.remove(id);
  }

  // scope latest jobs by owner and worktree
  private latestKey(owner: string, worktreeId: string): string { return `${owner}\0${worktreeId}`; }
}
