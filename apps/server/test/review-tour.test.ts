import { describe, expect, it } from 'vitest';
import { classifyReviewPath } from '../src/git/change-classification.js';
import { parseGeneratedReviewTour, parseReviewTourInput, prohibitedNarration, type ReviewSnapshot, type ReviewTour } from '../src/review-tour/contracts.js';
import { ReviewTourJobs } from '../src/review-tour/jobs.js';
import type { PreparedReviewTour, ReviewTourService } from '../src/review-tour/service.js';

const implementationChange = { id: 'chg_12345678', file: 'src/feature.ts', category: 'implementation' as const, kind: 'hunk' as const, patch: '@@ -1 +1 @@\n-old\n+new' };

// build one stable prepared snapshot
function prepared(worktreeId = 'cora'): PreparedReviewTour {
  const snapshot: ReviewSnapshot = { agentId: `agent-${worktreeId}`, worktreeId, workspace: `/worktrees/${worktreeId}`, branch: 'feature/review-tour', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: `fingerprint-${worktreeId}`, changes: [implementationChange] };
  return { snapshot, resolved: { workspace: snapshot.workspace, agent: { id: snapshot.agentId, paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: snapshot.workspace, branch: snapshot.branch, title: 'Ready' }, worktree: { id: worktreeId, label: worktreeId, path: snapshot.workspace, identity: snapshot.workspace, available: true, pinned: false } } };
}

// complete a deferred operation
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('review change classification', () => {
  it('classifies implementation, tests, and documentation with documentation precedence', () => {
    expect(classifyReviewPath('src/auth/service.ts')).toBe('implementation');
    expect(classifyReviewPath('src/auth/service.test.ts')).toBe('test');
    expect(classifyReviewPath('e2e/login.spec.ts')).toBe('test');
    expect(classifyReviewPath('README.md')).toBe('doc');
    expect(classifyReviewPath('docs/example.test.md')).toBe('doc');
  });
});

describe('review tour contracts', () => {
  it('requires the exact request shape', () => {
    expect(parseReviewTourInput({ scope: 'working', includeTests: false, includeDocs: true })).toEqual({ scope: 'working', includeTests: false, includeDocs: true });
    expect(parseReviewTourInput({ scope: 'working', includeTests: false, includeDocs: true, unexpected: true })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'branch', includeTests: false, includeDocs: false })).toBeUndefined();
  });

  it('accepts complete one-time change assignments and rejects finding-shaped narration', () => {
    const valid = { title: 'Authentication flow', overview: 'Walk through the request path.', steps: [{ id: 'authentication', title: 'Wire the request', explanation: 'The handler delegates to the service.', changeIds: [implementationChange.id] }] };
    expect(parseGeneratedReviewTour(valid, [implementationChange])).toEqual(valid);
    expect(prohibitedNarration('Ｆｉｎｄｉｎｇ: unsafe branch')).toBe(true);
    expect(parseGeneratedReviewTour({ ...valid, title: 'Finding: unsafe branch' }, [implementationChange])).toBeUndefined();
    expect(parseGeneratedReviewTour({ ...valid, steps: [{ ...valid.steps[0], changeIds: ['chg_unknown0'] }] }, [implementationChange])).toBeUndefined();
  });
});

describe('review tour jobs', () => {
  it('hides jobs across owners and publishes successful generation', async () => {
    const result = deferred<ReviewTour>();
    const service = { prepare: async () => prepared(), generate: async () => await result.promise } as unknown as ReviewTourService;
    const saved: Array<{ worktreeId: string; branch: string; tour: ReviewTour }> = [];
    const store = { save: async (worktreeId: string, branch: string, tour: ReviewTour) => { saved.push({ worktreeId, branch, tour }); return { worktreeId, branch, savedAt: new Date().toISOString(), tour }; } };
    const jobs = new ReviewTourJobs(service, store as never);
    try {
      const started = await jobs.start('owner-a', 'agent-cora', { scope: 'working', includeTests: false, includeDocs: false });
      expect(started.kind).toBe('pending');
      // require a pending job id
      if (started.kind !== 'pending') throw new Error('expected pending job');
      expect(jobs.get('owner-b', started.job.id)).toBeUndefined();
      result.resolve({ title: 'Tour', overview: 'Overview', steps: [{ id: 'step', title: 'Step', explanation: 'Explanation', changeIds: [implementationChange.id] }], ...prepared().snapshot });
      await viWait();
      expect(jobs.get('owner-a', started.job.id)?.state.kind).toBe('ready');
      expect(saved).toMatchObject([{ worktreeId: 'cora', branch: 'feature/review-tour' }]);
    } finally { jobs.close(); }
  });

  it('supersedes the previous worktree job and aborts its generation', async () => {
    const signals: AbortSignal[] = [];
    const service = {
      prepare: async () => prepared(),
      generate: async (_prepared: PreparedReviewTour, signal: AbortSignal) => {
        signals.push(signal);
        return await new Promise<ReviewTour>(() => {});
      }
    } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      const first = await jobs.start('owner-a', 'agent-cora', { scope: 'working', includeTests: false, includeDocs: false });
      const second = await jobs.start('owner-a', 'agent-cora', { scope: 'working', includeTests: true, includeDocs: false });
      // require pending job descriptors
      if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('expected pending jobs');
      expect(jobs.get('owner-a', first.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
      expect(signals[0]?.aborted).toBe(true);
      expect(jobs.cancel('owner-b', second.job.id)).toBe(false);
      expect(jobs.cancel('owner-a', second.job.id)).toBe(true);
      expect(signals[1]?.aborted).toBe(true);
    } finally { jobs.close(); }
  });

  it('keeps another owner job independent on the same worktree', async () => {
    const service = { prepare: async () => prepared(), generate: async () => await new Promise<ReviewTour>(() => {}) } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      const first = await jobs.start('owner-a', 'agent-cora', { scope: 'working', includeTests: false, includeDocs: false });
      const second = await jobs.start('owner-b', 'agent-cora', { scope: 'working', includeTests: false, includeDocs: false });
      // require pending job descriptors
      if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('expected pending jobs');
      expect(jobs.get('owner-a', first.job.id)?.state.kind).toBe('pending');
      expect(jobs.get('owner-b', second.job.id)?.state.kind).toBe('pending');
    } finally { jobs.close(); }
  });
});

// yield pending promise continuations
async function viWait(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
