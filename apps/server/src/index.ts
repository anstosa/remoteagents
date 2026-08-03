import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { validateConfig } from './config/schema.js';
import { buildApp } from './app.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PushService } from './push-service.js';
import { AgentNotificationCoordinator } from './notifications.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { CleanupService } from './cleanup/service.js';
import { CleanupMonitor } from './cleanup/monitor.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const file = process.env.RAC_CONFIG; if (!file) throw new Error('RAC_CONFIG must point to a server-local configuration file');
const config = await validateConfig(JSON.parse(await readFile(file, 'utf8'))); const tmux = new TmuxAdapter(); const discovery = new DiscoveryService(undefined, tmux); const push = new PushService(); const cleanup = new CleanupService(discovery, undefined, tmux);
const notificationPollMs = Math.max(1_000, config.pollIntervalMs);
const notifications = new AgentNotificationCoordinator(notification => push.notify(notification), Math.max(2_000, notificationPollMs * 2));
const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.worktrees, dashboard.cleanupPending]));
const app = await buildApp(config, { tmux, discovery, push, notifications, cleanup, dashboardUpdates });
const dashboardTimer = setInterval(() => void dashboardUpdates.refresh().catch(() => {}), notificationPollMs);
const cleanupMonitor = new CleanupMonitor(cleanup, dashboardUpdates, push);
app.addHook('onClose', async () => { clearInterval(dashboardTimer); cleanupMonitor.stop(); notifications.stop(); });
void dashboardUpdates.refresh().catch(() => {});
cleanupMonitor.start();
await app.listen(config.listen);
