import type { Agent, Dashboard, DashboardProject, DashboardWorktree, StackAction } from '../domain/models.js';
import type { LaunchResolution } from '../launch/resolution.js';
import type { ReviewTourCapability, StoredReviewTourSummary } from '../review-tour/contracts.js';

type StackState = { running?: boolean; transition?: 'starting' | 'migrating'; operation?: StackAction; tunnel?: boolean };
// one Worktree on the wire, augmented with the per-Worktree state the loader adds:
// whether its last agent is sleeping, its stack controls, and its resolved Launch profile
export type PayloadWorktree = DashboardWorktree & { sleeping?: boolean; stack?: StackState; launch?: LaunchResolution };
export type DashboardPayload = Omit<Dashboard, 'agents' | 'projects'> & {
  // `launch` carries each scope's resolved Launch profile so the web renders the Launch
  // menu without re-deriving it (a running agent's is its worktree's; a scratch agent's
  // is `scratchLaunch`); `scratchLaunch` is the Scratch group's resolution.
  agents: Array<Agent & { unread: boolean; queuedPromptCount: number; stack?: StackState; launch?: LaunchResolution }>;
  projects: Array<Omit<DashboardProject, 'worktrees'> & { worktrees: PayloadWorktree[] }>;
  cleanupPending: number;
  scratchLaunch?: LaunchResolution;
  reviewTour: ReviewTourCapability;
  reviews: StoredReviewTourSummary[];
};

export class DashboardUpdates<T = DashboardPayload> {
  private loader?: () => Promise<T>;
  private current?: T;
  private fingerprint = '';
  private refreshInFlight?: Promise<T>;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private readonly identify: (value: T) => string = value => JSON.stringify(value)) {}

  setLoader(loader: () => Promise<T>): void { this.loader = loader; }

  refresh(): Promise<T> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    if (this.loader === undefined) return Promise.reject(new Error('dashboard loader unavailable'));
    const refresh = this.loader().then(value => {
      const fingerprint = this.identify(value);
      this.current = value;
      if (fingerprint === this.fingerprint) return value;
      this.fingerprint = fingerprint;
      for (const listener of this.listeners) {
        try { listener(value); }
        catch { this.listeners.delete(listener); }
      }
      return value;
    }).finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    if (this.current !== undefined) {
      try { listener(this.current); }
      catch (error) {
        this.listeners.delete(listener);
        throw error;
      }
    }
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.loader = undefined;
    this.listeners.clear();
  }
}
