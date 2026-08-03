import { describe, expect, it } from 'vitest';
import { LatestViewportScheduler, PaneViewportCoordinator } from '../src/logs/viewport-scheduler.js';

describe('latest viewport scheduling', () => {
  it('applies a newer full-height viewport after an older resize already started', async () => {
    let releaseShortResize: (() => void) | undefined;
    const shortResize = new Promise<void>(resolve => { releaseShortResize = resolve; });
    const resized: Array<[number, number]> = [];
    const shown: number[] = [];
    const scheduler = new LatestViewportScheduler(async (cols, rows) => {
      resized.push([cols, rows]);
      if (rows === 30) await shortResize;
      return true;
    }, history => shown.push(history));

    const short = scheduler.schedule({ cols: 120, rows: 30, history: 0 });
    await Promise.resolve();
    const full = scheduler.schedule({ cols: 220, rows: 90, history: 0 });
    releaseShortResize?.();
    await Promise.all([short, full]);

    expect(resized).toEqual([[120, 30], [220, 90]]);
    expect(shown).toEqual([0]);
  });

  it('skips superseded viewport requests that have not started resizing', async () => {
    const resized: Array<[number, number]> = [];
    const scheduler = new LatestViewportScheduler(async (cols, rows) => { resized.push([cols, rows]); return true; }, () => {});

    const first = scheduler.schedule({ cols: 120, rows: 30, history: 0 });
    const latest = scheduler.schedule({ cols: 220, rows: 90, history: 0 });
    await Promise.all([first, latest]);

    expect(resized).toEqual([[220, 90]]);
  });
});

describe('pane viewport coordination', () => {
  it('restores the original desktop pane after a mobile viewer disconnects', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator();
    const lease = coordinator.acquire('socket:%1', async () => ({ cols: 220, rows: 80 }), async (cols, rows) => { applied.push([cols, rows]); return true; });

    await expect(lease.resize(62, 41)).resolves.toBe(true);
    await lease.release();

    expect(applied).toEqual([[62, 41], [220, 80]]);
  });

  it('heals a pane already stuck at mobile dimensions after a desktop viewer connects', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator();
    const lease = coordinator.acquire('socket:%1', async () => ({ cols: 62, rows: 41 }), async (cols, rows) => { applied.push([cols, rows]); return true; });

    await expect(lease.resize(307, 70)).resolves.toBe(true);
    await lease.release();

    expect(applied).toEqual([[307, 70], [307, 70]]);
  });

  it('retries the largest known viewport during release after a transient resize failure', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator();
    let attempts = 0;
    const lease = coordinator.acquire('socket:%1', async () => ({ cols: 62, rows: 41 }), async (cols, rows) => {
      applied.push([cols, rows]);
      attempts += 1;
      return attempts > 1;
    });

    await expect(lease.resize(307, 70)).resolves.toBe(false);
    await lease.release();

    expect(applied).toEqual([[307, 70], [307, 70]]);
  });

  it('does not let a stale client restore over a newer viewport owner', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator();
    const first = coordinator.acquire('socket:%1', async () => ({ cols: 220, rows: 80 }), async (cols, rows) => { applied.push([cols, rows]); return true; });
    await first.resize(62, 41);
    const latest = coordinator.acquire('socket:%1', async () => ({ cols: 62, rows: 41 }), async (cols, rows) => { applied.push([cols, rows]); return true; });

    await first.release();
    await latest.resize(307, 70);
    await latest.release();

    expect(applied).toEqual([[62, 41], [307, 70], [307, 80]]);
  });
});
