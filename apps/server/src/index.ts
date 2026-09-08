import { existsSync } from 'node:fs';
import { acquireConfig, migrationErrorLines } from './migrations/boot.js';
import { retireBookmarks } from './conversations/retire-bookmarks.js';
import { formatSavedPromptsToNotes, migrateSavedPromptsToNotes } from './migrations/saved-prompts-to-notes.js';
import { buildApp } from './app.js';
import { WorktreeNoteService } from './notes/service.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PushService } from './push-service.js';
import { AgentNotificationCoordinator } from './notifications.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { CleanupService } from './cleanup/service.js';
import { CleanupMonitor } from './cleanup/monitor.js';
import { WorktreeLaunchStore } from './worktrees/store.js';
import { WorktreeManagementService } from './worktrees/management.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// migrate a legacy config in place, then validate; surface every content or writability
// problem as `Configuration invalid:` lines and exit, never an unhandled-rejection trace
const config = await acquireConfig().catch((error: unknown) => {
  for (const message of migrationErrorLines(error)) process.stderr.write(`Configuration invalid: ${message}\n`);
  process.exit(1);
});
// retire any pre-existing Bookmark store once: log each saved bookmark and set the file aside
// (Conversations replace bookmarks; ADR 0007). A missing file is a no-op, so this fires once.
await retireBookmarks();
const tmux = new TmuxAdapter(); const worktreeStore = new WorktreeLaunchStore(); const discovery = new DiscoveryService(undefined, tmux, undefined, undefined, config.adapters, config.projects, worktreeStore); const push = new PushService(); const worktreeManagement = new WorktreeManagementService(() => config.projects); const cleanup = new CleanupService(discovery, undefined, tmux, undefined, worktreeManagement);
const notificationPollMs = Math.max(1_000, config.pollIntervalMs);
const notifications = new AgentNotificationCoordinator(notification => push.notify(notification), Math.max(2_000, notificationPollMs * 2));
const dashboardUpdates = new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.projects, dashboard.cleanupPending, dashboard.reviewTour, dashboard.reviews]));
// carry any legacy saved prompts into Notes before the app builds, then hand buildApp the same
// notes service; the source file is moved aside so a second boot is a no-op. This must run AFTER
// acquireConfig (above), which re-keys a legacy saved-prompts file onto `<projectId>:<realpath>`
// wire ids — otherwise projectIdOf would read a legacy key and skip every prompt as unconfigured.
const notes = new WorktreeNoteService();
const savedPromptsLines = formatSavedPromptsToNotes(await migrateSavedPromptsToNotes({ projectIds: config.projects.map(project => project.id), notes }));
if (savedPromptsLines.length > 0) { process.stderr.write('Saved prompts migration:\n'); for (const line of savedPromptsLines) process.stderr.write(`  ${line}\n`); }
const app = await buildApp(config, { tmux, discovery, push, notifications, cleanup, dashboardUpdates, worktreeStore, worktreeManagement, notes });
const dashboardTimer = setInterval(() => void dashboardUpdates.refresh().catch(() => {}), notificationPollMs);
const cleanupMonitor = new CleanupMonitor(cleanup, dashboardUpdates, push);
app.addHook('onClose', async () => { clearInterval(dashboardTimer); cleanupMonitor.stop(); notifications.stop(); });
void dashboardUpdates.refresh().catch(() => {});
cleanupMonitor.start();
// fire enabled Schedules unattended, beside the other periodic jobs; buildApp's onClose stops it
app.scheduler.start();
await app.listen(config.listen);
