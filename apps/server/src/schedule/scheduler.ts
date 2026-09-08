import { dueInstant } from './cron.js';
import type { Schedule } from './types.js';

/** One scheduled note the tick evaluates: its persistence key, its id and its Schedule. */
export type ScheduledNote = { key: string; note: { id: string; schedule?: Schedule } };
/** Run one Note's Schedule once at the instant `at`; the outcome is recorded by the runner itself. */
export type ScheduleRunner = (key: string, noteId: string, at: string) => Promise<unknown>;
/**
 * Advance one in-flight managed Run (its `lastRun.status` is `running`): observe its pane and, when it
 * has finished (or timed out, or its pane is gone), record a terminal status and close the pane. A no-op
 * for a Run that is still working. Kept separate from {@link ScheduleRunner} so the tick can reconcile a
 * running Note without ever re-dispatching it.
 */
export type ScheduleReconciler = (key: string, noteId: string) => Promise<unknown>;

/**
 * Fires enabled Schedules while nobody is watching. Modelled on the cleanup monitor: a
 * once-a-minute interval, a re-entrancy guard, errors logged and swallowed, started at boot and
 * stopped on close. Each tick evaluates every scheduled note against the no-catch-up anchor
 * (`bootAt`, the Schedule's `updatedAt` and its last Run), collapses any backlog into a single due
 * instant, and runs the due Schedules one after another so per-worktree launch serialization is
 * never tripped by the scheduler itself. A Note whose last Run is still `running` is reconciled (its
 * managed pane watched to completion and closed) and never re-dispatched, so one Run per Note holds
 * across the whole managed lifecycle. `tick(now)` is exposed so tests drive it without timers.
 */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  // the last due instant already dispatched per note (`key:noteId` → ISO). The persisted `lastRun`
  // advances the anchor across ticks, but a persist failure would leave the anchor unchanged and re-fire
  // the same instant every minute (a runaway launch). This in-memory guard makes a due instant fire once
  // per process regardless of persistence; the boot anchor still prevents any replay across a restart.
  private readonly dispatched = new Map<string, string>();

  constructor(
    private readonly scheduled: () => Promise<ScheduledNote[]>,
    private readonly run: ScheduleRunner,
    private readonly bootAt: Date,
    private readonly intervalMs = 60 * 1_000,
    private readonly reconcile: ScheduleReconciler = async () => {}
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.runGuarded();
    this.timer = setInterval(() => void this.runGuarded(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // evaluate and fire every due Schedule for `now`; a disabled Schedule or an unparseable stored
  // expression yields no due instant and never fires. A single Schedule's failure is swallowed so
  // one broken Schedule never stalls the rest of the tick.
  async tick(now: Date): Promise<void> {
    const scheduled = await this.scheduled();
    // forget dispatch marks for notes that no longer carry a Schedule, so the guard stays bounded by live notes
    const live = new Set(scheduled.map(({ key, note }) => `${key}:${note.id}`));
    for (const flightKey of this.dispatched.keys()) if (!live.has(flightKey)) this.dispatched.delete(flightKey);
    for (const { key, note } of scheduled) {
      const schedule = note.schedule;
      // an in-flight managed Run is reconciled first — even if its Schedule was since paused or its
      // cron edited — and never re-dispatched, so exactly one managed Run is alive per Note at a time
      if (schedule?.lastRun?.status === 'running') { await this.reconcile(key, note.id).catch(() => undefined); continue; }
      if (schedule === undefined || !schedule.enabled) continue;
      const due = dueInstant(schedule, now, this.bootAt);
      if (due === undefined) continue;
      const at = due.toISOString();
      const flightKey = `${key}:${note.id}`;
      // a due instant is attempted once per process even if recording its outcome fails downstream
      if (this.dispatched.get(flightKey) === at) continue;
      this.dispatched.set(flightKey, at);
      await this.run(key, note.id, at).catch(() => undefined);
    }
  }

  // a re-entrant tick (a slow Run outrunning the interval) is coalesced into the one in flight,
  // exactly like the cleanup monitor's scan.
  private runGuarded(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.tick(new Date())
      .catch(error => { console.warn('[schedule] tick errored:', error); })
      .finally(() => { if (this.running === running) this.running = undefined; });
    this.running = running;
    return running;
  }
}
