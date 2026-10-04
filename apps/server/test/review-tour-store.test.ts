import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewTour } from '../src/review-tour/contracts.js';
import { ReviewTourStore } from '../src/review-tour/store.js';

const directories: string[] = [];
const tour: ReviewTour = {
  title: 'Request routing tour',
  overview: 'Follow the request through the implementation.',
  scope: 'pr',
  base: 'origin/main',
  includeTests: false,
  includeDocs: false,
  fingerprint: 'fingerprint-1234567890',
  changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }],
  steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }]
};

afterEach(async () => {
  // remove isolated durable stores
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('review tour store', () => {
  it('survives service restarts and is permanently forgotten after a branch change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-store-'));
    directories.push(directory);
    const file = join(directory, 'reviews.json');
    const first = new ReviewTourStore(file);
    const stored = await first.save('cora', 'feature/one', tour);
    expect(stored).toMatchObject({ worktreeId: 'cora', branch: 'feature/one', tour: { fingerprint: tour.fingerprint } });

    const restarted = new ReviewTourStore(file);
    expect(await restarted.current('cora', 'feature/one')).toMatchObject({ branch: 'feature/one', tour: { title: tour.title } });
    expect(await restarted.summaries([{ worktreeId: 'cora', branch: 'feature/one' }])).toEqual([expect.objectContaining({ worktreeId: 'cora', branch: 'feature/one', title: tour.title })]);

    expect(await restarted.current('cora', 'feature/two')).toBeUndefined();
    const switchedBack = new ReviewTourStore(file);
    expect(await switchedBack.current('cora', 'feature/one')).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
  });

  it('keys by the Worktree wire id, whose path carries `:` and `/`', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-wire-'));
    directories.push(directory);
    const store = new ReviewTourStore(join(directory, 'reviews.json'));
    const id = 'proj:/home/me/code/repo-feature';
    // the old `[A-Za-z0-9_-]{1,80}` key rejected this and every real save silently failed
    expect(await store.save(id, 'feature/one', tour)).toMatchObject({ worktreeId: id, branch: 'feature/one' });
    expect(await store.current(id, 'feature/one')).toMatchObject({ branch: 'feature/one', tour: { title: tour.title } });
  });

  it('keeps a Code review beside the tour file, refusing superseded saves and other branches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-code-review-'));
    directories.push(directory);
    const file = join(directory, 'reviews.json');
    const store = new ReviewTourStore(file);
    const review = { fingerprint: tour.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'codex' as const }, findings: [], general: [{ id: 'fnd_0123456789abcdef', severity: 'low' as const, title: 'No test', body: 'Nothing covers it.' }], completedAt: new Date().toISOString() };
    const stale = store.beginCodeReview('cora');
    const current = store.beginCodeReview('cora');
    expect(await store.saveCodeReviewIfCurrent('cora', 'feature/one', review, stale)).toBe(false);
    expect(await store.saveCodeReviewIfCurrent('cora', 'feature/one', review, current)).toMatchObject({ branch: 'feature/one' });
    expect(JSON.parse(await readFile(join(directory, 'reviews.code-reviews.json'), 'utf8'))).toMatchObject({ cora: { branch: 'feature/one', review: { fingerprint: tour.fingerprint } } });
    await store.save('cora', 'feature/one', tour);
    expect(await store.summaries([{ worktreeId: 'cora', branch: 'feature/one' }])).toEqual([expect.objectContaining({ codeReview: 'ready', findings: 1 })]);
    expect(await store.current('cora', 'feature/two')).toBeUndefined();
    expect(await store.codeReview('cora', 'feature/one', tour.fingerprint)).toBeUndefined();
    expect(JSON.parse(await readFile(join(directory, 'reviews.code-reviews.json'), 'utf8'))).toEqual({});
  });

  it('dismisses a current cached review idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-dismiss-'));
    directories.push(directory);
    const store = new ReviewTourStore(join(directory, 'reviews.json'));
    await store.save('cora', 'feature/one', tour);
    expect(await store.dismiss('cora')).toBe(true);
    expect(await store.dismiss('cora')).toBe(false);
    expect(await store.current('cora', 'feature/one')).toBeUndefined();
  });
});
