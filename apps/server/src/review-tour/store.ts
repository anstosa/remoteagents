import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseReviewTour, type ReviewTour, type StoredReviewTour, type StoredReviewTourSummary } from './contracts.js';

type StoredReviews = Record<string, StoredReviewTour>;
type BranchBinding = { worktreeId: string; branch?: string };

const maxWorktrees = 100;
const maxBranchLength = 1_024;
const maxStoredBytes = 100 * 1024 * 1024;
// keyed by the Worktree wire id `<projectId>:<realpath>` (ADR 0003), so accept the `:`
// and `/` the path carries — bounded, single-line, no NUL — not just the old bare id
const validWorktreeId = (value: string) => value.length >= 1 && value.length <= 4096 && !/[\0\n\r]/u.test(value);
const validBranch = (value: string) => value.length > 0 && value.length <= maxBranchLength && !value.includes('\0');

// validate one durable review record
function parseStoredReview(value: unknown, expectedWorktreeId: string): StoredReviewTour | undefined {
  // require a plain object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { worktreeId?: unknown; branch?: unknown; savedAt?: unknown; tour?: unknown };
  // validate durable identity fields
  if (stored.worktreeId !== expectedWorktreeId || typeof stored.branch !== 'string' || !validBranch(stored.branch) || typeof stored.savedAt !== 'string' || !Number.isFinite(Date.parse(stored.savedAt))) return undefined;
  const tour = parseReviewTour(stored.tour);
  return tour === undefined ? undefined : { worktreeId: expectedWorktreeId, branch: stored.branch, savedAt: stored.savedAt, tour };
}

// copy a safe dashboard summary
function summary(stored: StoredReviewTour): StoredReviewTourSummary {
  return { worktreeId: stored.worktreeId, branch: stored.branch, savedAt: stored.savedAt, title: stored.tour.title, scope: stored.tour.scope, includeTests: stored.tour.includeTests, includeDocs: stored.tour.includeDocs, fingerprint: stored.tour.fingerprint };
}

export class ReviewTourStore {
  private mutation = Promise.resolve();
  private readonly generations = new Map<string, number>();
  private readonly generationBranches = new Map<string, string>();

  constructor(private readonly file = process.env.RAC_REVIEW_TOURS_FILE ?? '.data/review-tours.json') {}

  // persist the latest tour for one branch
  async save(worktreeId: string, branch: string, tour: ReviewTour): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseReviewTour(tour) === undefined) return undefined;
    return await this.mutate<StoredReviewTour | undefined>(stored => {
      // cap distinct configured worktrees
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return { value: undefined, changed: false };
      const review = { worktreeId, branch, savedAt: new Date().toISOString(), tour };
      stored[worktreeId] = review;
      return { value: review, changed: true };
    });
  }

  // serialize one new generation identity
  async invalidate(worktreeId: string, branch?: string): Promise<number | undefined> {
    if (!validWorktreeId(worktreeId) || (branch !== undefined && !validBranch(branch))) return undefined;
    return await this.mutate(stored => {
      const generation = (this.generations.get(worktreeId) ?? 0) + 1;
      this.generations.set(worktreeId, generation);
      // bind pending persistence to its observed branch
      if (branch === undefined) this.generationBranches.delete(worktreeId);
      else this.generationBranches.set(worktreeId, branch);
      const changed = stored[worktreeId] !== undefined;
      // remove the artifact invalidated by this generation
      if (changed) delete stored[worktreeId];
      return { value: generation, changed };
    });
  }

  // persist only while one generation remains current
  async saveIfCurrent(worktreeId: string, branch: string, tour: ReviewTour, generation: number): Promise<StoredReviewTour | false | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseReviewTour(tour) === undefined) return undefined;
    return await this.mutate<StoredReviewTour | false | undefined>(stored => {
      // reject superseded generation inside the serialized mutation
      if (this.generations.get(worktreeId) !== generation) return { value: false, changed: false };
      // reject a generation prepared on another branch
      if (this.generationBranches.get(worktreeId) !== branch) return { value: false, changed: false };
      // cap distinct configured worktrees
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return { value: undefined, changed: false };
      const review = { worktreeId, branch, savedAt: new Date().toISOString(), tour };
      stored[worktreeId] = review;
      return { value: review, changed: true };
    });
  }

  // invalidate one still-current generation
  async invalidateIfCurrent(worktreeId: string, generation: number): Promise<boolean> {
    if (!validWorktreeId(worktreeId)) return false;
    return await this.mutate(stored => {
      // preserve a newer generation
      if (this.generations.get(worktreeId) !== generation) return { value: false, changed: false };
      this.generations.set(worktreeId, generation + 1);
      this.generationBranches.delete(worktreeId);
      const changed = stored[worktreeId] !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: true, changed };
    });
  }

  // read only a review from the current branch
  async current(worktreeId: string, branch: string | undefined): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId) || branch === undefined || !validBranch(branch)) return undefined;
    return await this.mutate(stored => {
      const review = stored[worktreeId];
      const generationBranch = this.generationBranches.get(worktreeId);
      // return a current branch match
      if ((generationBranch === undefined || generationBranch === branch) && (review === undefined || review.branch === branch)) return { value: review, changed: false };
      // invalidate pending and durable reviews after branch changes
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.set(worktreeId, branch);
      const changed = review !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: undefined, changed };
    });
  }

  // expose current-branch summaries and prune branch changes
  async summaries(bindings: BranchBinding[]): Promise<StoredReviewTourSummary[]> {
    const branches = new Map(bindings.filter(binding => validWorktreeId(binding.worktreeId) && binding.branch !== undefined && validBranch(binding.branch)).map(binding => [binding.worktreeId, binding.branch!]));
    return await this.mutate(stored => {
      let changed = false;
      const reviews: StoredReviewTourSummary[] = [];
      // invalidate pending generations observed on another branch
      for (const [worktreeId, branch] of branches) {
        const generationBranch = this.generationBranches.get(worktreeId);
        // retain generations without a pending branch binding
        if (generationBranch === undefined || generationBranch === branch) continue;
        this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
        this.generationBranches.set(worktreeId, branch);
      }
      // reconcile every stored review with its configured worktree branch
      for (const [worktreeId, review] of Object.entries(stored)) {
        const branch = branches.get(worktreeId);
        // retain records until their configured branch can be observed
        if (branch === undefined) continue;
        // permanently prune a branch mismatch
        if (branch !== review.branch) { delete stored[worktreeId]; this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1); this.generationBranches.set(worktreeId, branch); changed = true; continue; }
        reviews.push(summary(review));
      }
      return { value: reviews, changed };
    });
  }

  // dismiss one durable review
  async dismiss(worktreeId: string): Promise<boolean> {
    if (!validWorktreeId(worktreeId)) return false;
    return await this.mutate(stored => {
      const existed = stored[worktreeId] !== undefined;
      // invalidate pending generation even without an artifact
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.delete(worktreeId);
      // remove only an existing record
      if (existed) delete stored[worktreeId];
      return { value: existed, changed: existed };
    });
  }

  // serialize all file mutations
  private async mutate<T>(change: (stored: StoredReviews) => { value: T; changed: boolean }): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = change(stored);
      // avoid writes for pure reads
      if (result.changed) await this.write(stored);
      return result.value;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // read and validate the durable store
  private async read(): Promise<StoredReviews> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      // treat a missing store as empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    // reject oversized durable state
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('review tour store exceeds storage limits');
    const raw = JSON.parse(serialized) as unknown;
    // require a plain record
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid review tour store');
    const entries = Object.entries(raw);
    // enforce worktree count limits
    if (entries.length > maxWorktrees) throw new Error('review tour store exceeds storage limits');
    const stored: StoredReviews = {};
    // validate every stored worktree
    for (const [worktreeId, value] of entries) {
      const review = validWorktreeId(worktreeId) ? parseStoredReview(value, worktreeId) : undefined;
      // fail closed on corrupt state
      if (review === undefined) throw new Error('invalid review tour store');
      stored[worktreeId] = review;
    }
    return stored;
  }

  // atomically replace durable state
  private async write(value: StoredReviews): Promise<void> {
    const serialized = JSON.stringify(value);
    // enforce the aggregate storage boundary
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('review tour store exceeds storage limits');
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, serialized, { mode: 0o600 });
    await rename(next, this.file);
  }
}
