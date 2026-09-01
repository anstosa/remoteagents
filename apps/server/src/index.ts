import { existsSync } from 'node:fs';
import { acquireConfig, migrationErrorLines } from './migrations/boot.js';
import { buildApp } from './app.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PushService } from './push-service.js';
import { AgentNotificationCoordinator } from './notifications.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { CleanupService } from './cleanup/service.js';
import { CleanupMonitor } from './cleanup/monitor.js';
import { WorktreeLaunchStore } from './worktrees/store.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// migrate a legacy config in place, then validate; surface every content or writability
// problem as `Configuration invalid:` lines and exit, never an unhandled-rejection trace
const config = await acquireConfig().catch((error: unknown) => {
  for (const message of migrationErrorLines(error)) process.stderr.write(`Configuration invalid: ${message}\n`);
  process.exit(1);
}); const tmux = new TmuxAdapter(); const worktreeStore = new WorktreeLaunchStore(); const discovery = new DiscoveryService(undefined, tmux, undefined, undefined, config.adapters, config.projects, worktreeStore); const push = new PushService(); const cleanup = new CleanupService(discovery, undefined, tmux);
const notificationPollMs = Math.max(1_000, config.pollIntervalMs);
const notifications = new AgentNotificationCoordinator(notification => push.notify(notification), Math.max(2_000, notificationPollMs * 2));
const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.projects, dashboard.cleanupPending, dashboard.reviewTour, dashboard.reviews]));
const app = await buildApp(config, { tmux, discovery, push, notifications, cleanup, dashboardUpdates, worktreeStore });
const dashboardTimer = setInterval(() => void dashboardUpdates.refresh().catch(() => {}), notificationPollMs);
const cleanupMonitor = new CleanupMonitor(cleanup, dashboardUpdates, push);
app.addHook('onClose', async () => { clearInterval(dashboardTimer); cleanupMonitor.stop(); notifications.stop(); });
void dashboardUpdates.refresh().catch(() => {});
cleanupMonitor.start();
await app.listen(config.listen);
