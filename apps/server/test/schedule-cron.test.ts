// Fixed-date DST assertions below are written for the host's own zone; croner reads
// the process zone dynamically, so pinning it makes the suite deterministic anywhere.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { cronError, dueInstant, nextRun, previewRuns, scheduleAnchor, scheduleNextRun } from '../src/schedule/cron.js';
import type { Schedule } from '../src/schedule/types.js';

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({ cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00', ...overrides });
const iso = (date: Date | undefined) => date?.toISOString();

describe('cron parsing and preview', () => {
  it('reports croner errors for invalid expressions and passes valid ones', () => {
    expect(cronError('0 9 * * *')).toBeUndefined();
    expect(cronError('0 9 * * 1-5')).toBeUndefined();
    expect(cronError('0 25 * * *')).toMatch(/hour/i);
    expect(cronError('not a cron')).toBeTruthy();
    expect(cronError('0 0 9 * * *')).toMatch(/5 parts/i);
  });

  it('chains next-run calls for the preview and refuses an invalid expression', () => {
    const runs = previewRuns('0 9 * * *', new Date('2026-06-01T12:00:00-07:00'), 3);
    expect(runs?.map(iso)).toEqual(['2026-06-02T16:00:00.000Z', '2026-06-03T16:00:00.000Z', '2026-06-04T16:00:00.000Z']);
    expect(previewRuns('nope', new Date())).toBeUndefined();
    expect(nextRun('nope', new Date())).toBeUndefined();
  });
});

describe('scheduleAnchor', () => {
  it('is the latest of the last Run, the last settings change and boot', () => {
    const base = schedule({ updatedAt: '2026-01-10T08:30:00-08:00' });
    expect(iso(scheduleAnchor(base, new Date('2026-01-01T00:00:00-08:00')))).toBe('2026-01-10T16:30:00.000Z');
    expect(iso(scheduleAnchor(base, new Date('2026-01-20T00:00:00-08:00')))).toBe('2026-01-20T08:00:00.000Z');
    const ran = schedule({ updatedAt: '2026-01-10T08:30:00-08:00', lastRun: { at: '2026-01-25T09:00:00-08:00', status: 'launched' } });
    expect(iso(scheduleAnchor(ran, new Date('2026-01-01T00:00:00-08:00')))).toBe('2026-01-25T17:00:00.000Z');
  });
});

describe('dueInstant', () => {
  const boot = new Date('2026-01-01T00:00:00-08:00');

  it('does not fire an instant at or before updatedAt: created at 8:30 for daily 8:00 first fires tomorrow', () => {
    const created = schedule({ cron: '0 8 * * *', updatedAt: '2026-01-10T08:30:00-08:00' });
    expect(dueInstant(created, new Date('2026-01-10T09:00:00-08:00'), boot)).toBeUndefined();
    expect(iso(scheduleNextRun(created, boot))).toBe('2026-01-11T16:00:00.000Z');
    expect(iso(dueInstant(created, new Date('2026-01-11T08:30:00-08:00'), boot))).toBe('2026-01-11T16:00:00.000Z');
  });

  it('collapses a backlog to the latest due instant', () => {
    const daily = schedule({ cron: '0 9 * * *' });
    expect(iso(dueInstant(daily, new Date('2026-01-05T10:00:00-08:00'), boot))).toBe('2026-01-05T17:00:00.000Z');
  });

  it('fires once for a 2:30 daily on the spring-forward day', () => {
    const daily = schedule({ cron: '30 2 * * *' });
    const now = new Date('2026-03-09T00:00:00-08:00');
    expect(iso(dueInstant(daily, now, boot))).toBe('2026-03-08T10:30:00.000Z');
    const afterRun = schedule({ cron: '30 2 * * *', lastRun: { at: '2026-03-08T10:30:00.000Z', status: 'launched' } });
    expect(dueInstant(afterRun, now, boot)).toBeUndefined();
  });

  it('fires once for a 1:30 daily on the autumn overlap day', () => {
    const daily = schedule({ cron: '30 1 * * *' });
    const now = new Date('2026-11-01T20:00:00.000Z');
    expect(iso(dueInstant(daily, now, boot))).toBe('2026-11-01T08:30:00.000Z');
    const afterRun = schedule({ cron: '30 1 * * *', lastRun: { at: '2026-11-01T08:30:00.000Z', status: 'launched' } });
    expect(dueInstant(afterRun, now, boot)).toBeUndefined();
  });

  it('is undefined when the expression cannot parse', () => {
    expect(dueInstant(schedule({ cron: 'garbage' }), new Date('2026-06-01T12:00:00-07:00'), boot)).toBeUndefined();
  });
});
