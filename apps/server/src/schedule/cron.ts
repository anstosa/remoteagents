import { Cron } from 'croner';
import type { Schedule } from './types.js';

/**
 * Cron evaluation for Schedules. Every function is pure over its inputs: croner is
 * imported in 5-part mode with no timezone, so evaluation follows the process zone
 * and the preview and the fire always agree. Never `match()` — per-minute matching
 * double-fires in the autumn DST overlap; every question here is "the next instant
 * strictly after X".
 */
const cronOptions = { paused: true, mode: '5-part' } as const;
// bound the compile cache: the preview route parses caller-supplied expressions, so an
// unbounded cache would grow without limit. Insertion-order eviction keeps it simple.
const cacheLimit = 256;
const compiled = new Map<string, Cron>();

// Compile once per distinct expression; undefined when the expression is invalid.
const compile = (expression: string): Cron | undefined => {
  const cached = compiled.get(expression);
  if (cached !== undefined) return cached;
  let cron: Cron;
  try { cron = new Cron(expression, cronOptions); }
  catch { return undefined; }
  if (compiled.size >= cacheLimit) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(expression, cron);
  return cron;
};

/** croner's own parse error for an invalid 5-field expression, or undefined when it parses. */
export const cronError = (expression: string): string | undefined => {
  try {
    new Cron(expression, cronOptions);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid cron expression';
  }
};

/** The next instant strictly after `from`; undefined for an invalid or exhausted expression. */
export const nextRun = (expression: string, from: Date): Date | undefined => compile(expression)?.nextRun(from) ?? undefined;

/**
 * Up to `count` upcoming instants, computed by chaining `nextRun` (never
 * `nextRuns`, which can list a spring-forward instant twice). undefined for an
 * invalid expression.
 */
export const previewRuns = (expression: string, from: Date, count = 3): Date[] | undefined => {
  const cron = compile(expression);
  if (cron === undefined) return undefined;
  const runs: Date[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const next = cron.nextRun(cursor);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
};

/**
 * The no-catch-up anchor: the latest of the last Run, the last settings change and
 * boot. Anchoring on `updatedAt` means a Schedule created at 8:30 for "daily at
 * 8:00" first fires tomorrow; anchoring on boot means a restart never replays a
 * missed instant.
 */
export const scheduleAnchor = (schedule: Schedule, bootAt: Date): Date => {
  let anchor = Math.max(Date.parse(schedule.updatedAt), bootAt.getTime());
  const lastRun = schedule.lastRun === undefined ? Number.NaN : Date.parse(schedule.lastRun.at);
  if (!Number.isNaN(lastRun)) anchor = Math.max(anchor, lastRun);
  return new Date(anchor);
};

/** The next instant this Schedule will run, from the tick's own anchor, for display. */
export const scheduleNextRun = (schedule: Schedule, bootAt: Date): Date | undefined => nextRun(schedule.cron, scheduleAnchor(schedule, bootAt));

/**
 * The single due instant to fire this tick, or undefined when nothing is due. A
 * backlog (a stalled process, a long tick gap) collapses to the latest instant
 * that is still at or before `now`, so a Schedule fires once per tick, never a
 * burst.
 */
export const dueInstant = (schedule: Schedule, now: Date, bootAt: Date): Date | undefined => {
  let due = nextRun(schedule.cron, scheduleAnchor(schedule, bootAt));
  if (due === undefined || due.getTime() > now.getTime()) return undefined;
  for (let next = nextRun(schedule.cron, due); next !== undefined && next.getTime() <= now.getTime(); next = nextRun(schedule.cron, next)) {
    due = next;
  }
  return due;
};
