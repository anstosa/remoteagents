import type { DashboardPayload } from '../dashboard/updates.js';
import type { DashboardUpdates } from '../dashboard/updates.js';
import type { CleanupNotification } from '../notifications.js';
import type { CleanupTarget } from '../domain/models.js';

type Scanner = { scan(): Promise<CleanupTarget[]> };
type Notifier = { notify(message: CleanupNotification): Promise<unknown> };

export class CleanupMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly cleanup: Scanner,
    private readonly dashboard: Pick<DashboardUpdates<DashboardPayload>, 'refresh'>,
    private readonly push: Notifier,
    private readonly intervalMs = 60 * 60 * 1_000
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private run(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.cleanup.scan().then(async targets => {
      await this.dashboard.refresh().catch(() => undefined);
      if (targets.length === 0) return;
      await this.push.notify({
        kind: 'cleanup',
        title: 'Runtime cleanup available',
        body: `${targets.length} stale runtime ${targets.length === 1 ? 'target is' : 'targets are'} ready to clean up.`,
        tag: 'runtime-cleanup',
        url: '/#cleanup'
      });
    }).catch(() => undefined).finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }
}
