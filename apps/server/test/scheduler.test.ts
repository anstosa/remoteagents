// croner reads the process zone dynamically, so pin it for deterministic due-instant math.
process.env.TZ = 'America/Los_Angeles';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type ScheduledNote } from '../src/schedule/scheduler.js';
import type { Schedule } from '../src/schedule/types.js';

const boot = new Date('2026-01-01T00:00:00-08:00');
const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({ cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00', ...overrides });
const note = (id: string, overrides: Partial<Schedule> = {}, key = 'proj'): ScheduledNote => ({ key, note: { id, schedule: schedule(overrides) } });

describe('Scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks immediately and every minute while running, and stops on stop()', async () => {
    vi.useFakeTimers();
    const scheduled = vi.fn().mockResolvedValue([]);
    const scheduler = new Scheduler(scheduled, async () => {}, boot);
    scheduler.start();
    await vi.waitFor(() => expect(scheduled).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60 * 1_000);
    expect(scheduled).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * 1_000);
    expect(scheduled).toHaveBeenCalledTimes(2);
  });

  it('fires a due Schedule once with its due instant, and never one whose anchor is still ahead', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    // one daily-9am note that is due at the tick, one created after 9am today whose anchor pushes it to tomorrow
    const scheduler = new Scheduler(async () => [
      note('due'),
      note('fresh', { updatedAt: '2026-01-05T09:30:00-08:00' })
    ], run, boot);
    await scheduler.tick(new Date('2026-01-05T10:00:00-08:00'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('proj', 'due', '2026-01-05T17:00:00.000Z');
  });

  it('never fires a disabled Schedule or one whose stored expression cannot parse', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler(async () => [
      note('paused', { enabled: false }),
      note('broken', { cron: 'not a cron' })
    ], run, boot);
    await scheduler.tick(new Date('2026-01-05T10:00:00-08:00'));
    expect(run).not.toHaveBeenCalled();
  });

  it('runs due Schedules strictly one after another, not concurrently', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const run = vi.fn(async (_key: string, noteId: string) => {
      events.push(`start:${noteId}`);
      if (noteId === 'first') await firstGate;
      events.push(`end:${noteId}`);
    });
    const ticked = new Scheduler(async () => [note('first'), note('second')], run, boot).tick(new Date('2026-01-05T10:00:00-08:00'));
    // the second Run must not start until the first has settled (per-worktree launch serialization)
    await Promise.resolve();
    expect(events).toEqual(['start:first']);
    releaseFirst();
    await ticked;
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('swallows a single failing Run without stalling the rest of the tick', async () => {
    const order: string[] = [];
    const run = vi.fn(async (_key: string, noteId: string) => {
      order.push(noteId);
      if (noteId === 'first') throw new Error('boom');
    });
    const scheduler = new Scheduler(async () => [note('first'), note('second')], run, boot);
    await expect(scheduler.tick(new Date('2026-01-05T10:00:00-08:00'))).resolves.toBeUndefined();
    expect(order).toEqual(['first', 'second']);
  });

  it('dispatches a due instant only once per process, even when its outcome is never persisted', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    // scheduled() keeps returning the same due schedule with no lastRun (as if the record write failed),
    // so the anchor never advances between ticks; only the in-memory guard prevents a runaway re-fire
    const scheduler = new Scheduler(async () => [note('stuck')], run, boot);
    const now = new Date('2026-01-05T10:00:00-08:00');
    await scheduler.tick(now);
    await scheduler.tick(now);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces a re-entrant tick while one is still in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scheduled = vi.fn().mockImplementation(async () => { await gate; return []; });
    const scheduler = new Scheduler(scheduled, async () => {}, boot, 10);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(35);
    // the interval fired repeatedly but the first tick never resolved: only one scan is in flight
    expect(scheduled).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(scheduled).toHaveBeenCalledTimes(1));
    scheduler.stop();
  });
});
