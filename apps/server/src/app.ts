import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidatedConfig } from './config/schema.js';
import { AuthService, type Session } from './auth/service.js';
import { ControlService } from './auth/control.js';
import { DeviceService } from './auth/devices.js';
import { TicketStore, type TicketKind } from './auth/tickets.js';
import { DiscoveryService } from './discovery/service.js';
import { adapterFor } from './adapters/registry.js';
import { agentKinds, codexFamily, sameConversation, type Adapter, type AgentKind, type ConversationSummary, type PaneSnapshot, type ResetSettling } from './adapters/types.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { maxPromptAttachments, maxPromptAttachmentBytes, PromptService, type PromptAttachment } from './prompts/service.js';
import { validPrompt } from './prompts/validation.js';
import { QueuedPromptService, type QueuedPrompt } from './prompts/queue.js';
import { LaunchService } from './launch/service.js';
import { createAgentWaiter, launchPollAttempts, launchPollDelay as defaultLaunchPollDelay, launchReadyTimeoutSeconds } from './launch/wait.js';
import { scratchLaunchKey, WorktreeLaunchStore } from './worktrees/store.js';
import { safeEnv } from './tmux/command.js';
import { PushService } from './push-service.js';
import { WorktreeCommandService } from './worktree-commands/service.js';
import { PullRequestSwitchService } from './pull-requests/switch-service.js';
import { NewTaskService } from './new-task/service.js';
import { WorktreeManagementService } from './worktrees/management.js';
import { agentAttentionState, AgentNotificationCoordinator, reviewNotification, scheduleNotification, type AgentNotificationContext } from './notifications.js';
import { stackActions, type Agent, type SocketRef, type StackAction, type Worktree } from './domain/models.js';
import { CommandCatalogService } from './commands/service.js';
import { LatestViewportScheduler, PaneViewportCoordinator } from './logs/viewport-scheduler.js';
import { boundedViewport } from './logs/viewport.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { WorktreeNoteService, type WorktreeNote } from './notes/service.js';
import { promptNoteContent } from './notes/from-prompt.js';
import { cronError, previewRuns, scheduleNextRun } from './schedule/cron.js';
import { Scheduler } from './schedule/scheduler.js';
import { type Schedule, type ScheduleLastRun, type ScheduleTarget, validScheduleTarget } from './schedule/types.js';
import { CleanupService } from './cleanup/service.js';
import { PromptHistoryService } from './prompt-history/service.js';
import { ProjectProxy } from './project-proxy.js';
import { TemporaryPreviewAccess, temporaryPreviewCookie } from './temporary-previews/access.js';
import { TemporaryPreviewProxy } from './temporary-previews/proxy.js';
import { TemporaryPreviewService } from './temporary-previews/service.js';
import { CodexExecReviewTourGenerator } from './review-tour/generator.js';
import { ReviewTourService } from './review-tour/service.js';
import { ReviewTourJobs } from './review-tour/jobs.js';
import { ReviewTourStore } from './review-tour/store.js';
import { parseReviewRequestId, parseReviewTourInput, REVIEW_REQUEST_BODY_BYTES, ReviewTourError, type ReviewErrorCode, type ReviewTourInput } from './review-tour/contracts.js';
import { configuredWorktreeForWorkspace, projectIdOf, worktreeById, worktreeHostRoot, worktreeMatchesWorkspace, worktreePathOf, worktreeWireId } from './workspaces/resolver.js';
import { WorkspaceFileService } from './workspace-files/service.js';
import { instanceIconSvg, isInstanceIcon } from './instance-icon.js';
import { instanceAttention, RemoteInstanceStatusPoller, validInstanceStatusRequest, type InstanceStatus } from './instance-status.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { defaultIntegrationConfig, parseDavoSettings, resolveCodexProgram } from './config/schema.js';
import { OrchestrationService } from './orchestration/index.js';
import { IntegrationAuthService, registerIntegrationAuthServer, type IntegrationScope, type LocalIntegrationSubject } from './integrations/auth/index.js';
import { IntegrationPolicyService } from './integrations/policy/service.js';
import { IntegrationAuditService } from './integrations/audit/service.js';
import { IntegrationGateway, registerMcpServer } from './integrations/mcp/index.js';
import { RealtimeService } from './integrations/realtime/service.js';
import { federationForwarder, verifyFederationRequest } from './integrations/federation/index.js';
import { IntegrationControlService } from './integrations/control/index.js';
import { ServerAdminService } from './server-admin/service.js';
import { CodexAccountService, safeAccountId, type AccountRateLimitWindow, type AccountSummary } from './accounts/index.js';
import { ConsoleNamedConversationService, type ConsoleNamedConversation } from './conversations/console-named-service.js';
import { isUpdateAdvisorForTarget, isUpdateAdvisorLabel, updateAdvisorLabel, updateAdvisorPendingLabel } from './update-advisor.js';
import { isFullGitSha } from './git/revision.js';
import { AgentUpdateService, type AgentUpdateServiceLike } from './agent-updates/service.js';

export type Dependencies = { auth?: AuthService; control?: ControlService; devices?: DeviceService; discovery?: DiscoveryService; tmux?: TmuxAdapter; tickets?: TicketStore; launch?: LaunchService; launchPollDelay?: () => Promise<void>; conversationNamePollDelay?: () => Promise<void>; push?: PushService; notifications?: AgentNotificationCoordinator; prSwitch?: PullRequestSwitchService; newTask?: NewTaskService; promptHistory?: PromptHistoryService; queuedPrompts?: QueuedPromptService; prompts?: PromptService; notes?: WorktreeNoteService; consoleNamed?: ConsoleNamedConversationService; commandCatalog?: CommandCatalogService; cleanup?: CleanupService; dashboardUpdates?: DashboardUpdates<DashboardPayload>; reviewTours?: ReviewTourService; reviewStore?: ReviewTourStore; workspaceFiles?: WorkspaceFileService; serverAdmin?: ServerAdminService; accounts?: CodexAccountService; instanceStatusPoller?: Pick<RemoteInstanceStatusPoller, 'statuses'>; worktreeStore?: WorktreeLaunchStore; worktreeManagement?: WorktreeManagementService; worktreeCommands?: WorktreeCommandService; agentUpdates?: AgentUpdateServiceLike; temporaryPreviews?: Pick<TemporaryPreviewService, 'resolve'>; scheduleBootAt?: Date };
// buildApp decorates the returned instance with the Schedule scheduler, so index.ts can start it and
// the HTTP-seam tests can drive its `tick(now)` over the same fakes the Run routes use.
declare module 'fastify' {
  interface FastifyInstance { scheduler: Scheduler }
}
// derive one stable opaque scratch persistence group
const scratchSaveKey = (workspace: string) => `scratch_${createHash('sha256').update(workspace).digest('base64url').slice(0, 40)}`;
// bound full history scans
const logMetadataRefreshMs = 30_000;
const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {});
// one Named conversation on the wire: the Adapter's summary tagged with its kind, plus the
// server-resolved Worktree, console-named flag and whether it is the current Conversation
type ConversationRow = ConversationSummary & { kind: AgentKind; worktreeId?: string; consoleNamed: boolean; current: boolean };
// parse an optional launch kind from a request body; a present-but-unknown value is rejected
const requestedKind = (request: FastifyRequest): { kind?: AgentKind; invalid?: true } => {
  const value = body(request).kind;
  if (value === undefined) return {};
  return (agentKinds as readonly string[]).includes(value as string) ? { kind: value as AgentKind } : { invalid: true };
};
const promptAttachments = (value: unknown): PromptAttachment[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxPromptAttachments) return undefined;
  const attachments = value.map(candidate => candidate !== null && typeof candidate === 'object' && typeof (candidate as { name?: unknown }).name === 'string' && typeof (candidate as { data?: unknown }).data === 'string' ? candidate as PromptAttachment : undefined);
  return attachments.some(attachment => attachment === undefined) ? undefined : attachments as PromptAttachment[];
};
type LogFrame = { type: 'append'|'reset'; text: string };
// build one complete viewport frame
export function logFrame(last: string, value: string, refreshMetadata = false): LogFrame | undefined {
  // retain metadata-only refreshes
  if ((!value.trim() || value === last) && !refreshMetadata) return undefined;
  // Captures are complete viewport frames. Replaying a guessed suffix can
  // preserve cells that tmux already redrew, producing a mixed old/new frame.
  return { type: 'reset', text: value };
}
// build the console server
export async function buildApp(config: ValidatedConfig, deps: Dependencies = {}): Promise<FastifyInstance> {
  const auth = deps.auth ?? new AuthService(process.env.RAC_PASSWORD_HASH ?? '', process.env.RAC_SESSION_SECRET ?? ''); const control = deps.control ?? new ControlService(); const devices = deps.devices ?? new DeviceService(); const tmux = deps.tmux ?? new TmuxAdapter(); const worktreeStore = deps.worktreeStore ?? new WorktreeLaunchStore(); const discovery = deps.discovery ?? new DiscoveryService(undefined, tmux, undefined, undefined, config.adapters, config.projects, worktreeStore); const tickets = deps.tickets ?? new TicketStore(); const launch = deps.launch ?? new LaunchService(config, undefined, tmux, undefined, worktreeStore, () => discovery.worktreesNow()); const promptHistory = deps.promptHistory ?? new PromptHistoryService(); const queuedPrompts = deps.queuedPrompts ?? new QueuedPromptService(); const prompts = deps.prompts ?? new PromptService(discovery, tmux, promptHistory, queuedPrompts, (scope: string, prompt: QueuedPrompt) => drainUndelivered(scope, prompt), undefined, kind => config.adapters[kind]?.teardown); const notes = deps.notes ?? new WorktreeNoteService(); const consoleNamed = deps.consoleNamed ?? new ConsoleNamedConversationService(); const commandCatalog = deps.commandCatalog ?? new CommandCatalogService(); const workspaceFiles = deps.workspaceFiles ?? new WorkspaceFileService(); const push = deps.push ?? new PushService(); const notifications = deps.notifications ?? new AgentNotificationCoordinator(() => {}); const worktreeManagement = deps.worktreeManagement ?? new WorktreeManagementService(() => config.projects); const cleanup = deps.cleanup ?? new CleanupService(discovery, undefined, tmux, undefined, worktreeManagement); const stackCommands = deps.worktreeCommands ?? new WorktreeCommandService(config, discovery); const prSwitch = deps.prSwitch ?? new PullRequestSwitchService(config, discovery, tmux); const newTask = deps.newTask ?? new NewTaskService(config, discovery, tmux); const dashboardUpdates = deps.dashboardUpdates ?? new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.projects, dashboard.cleanupPending, dashboard.scratchLaunch, dashboard.reviewTour, dashboard.reviews])); const codexProgram = resolveCodexProgram(config); const reviewTours = deps.reviewTours ?? new ReviewTourService(discovery, new CodexExecReviewTourGenerator(codexProgram)); const reviewStore = deps.reviewStore ?? new ReviewTourStore(); const serverAdmin = deps.serverAdmin ?? new ServerAdminService(config);
  const temporaryPreviews = deps.temporaryPreviews ?? new TemporaryPreviewService();
  // freeze the checkout identity serving this process
  const deployedRevision = serverAdmin.revision();
  const reviewJobs = new ReviewTourJobs(reviewTours, reviewStore, async review => {
    const worktree = review.prepared.resolved.worktree;
    const projectName = config.projects.find(project => project.id === worktree.projectId)?.label ?? worktree.label;
    // refresh dashboard state and push independently
    await Promise.all([
      dashboardUpdates.refresh().then(() => undefined).catch(() => undefined),
      push.notify(reviewNotification(review.agentId, review.worktreeId, projectName, worktree.label)).then(() => undefined).catch(() => undefined)
    ]);
  });
  const reviewTourCapability = await reviewTours.capability();
  const accounts = deps.accounts ?? new CodexAccountService({ ...(codexProgram === undefined ? {} : { codexProgram }) });
  // tolerate narrow launch doubles while deriving the production launch account home
  const launchHome = typeof launch.agentHome === 'function' ? launch.agentHome() : process.env.HOME ?? '/';
  const agentUpdates = deps.agentUpdates ?? new AgentUpdateService(config, launchHome);
  const paneViewports = new PaneViewportCoordinator();
  const updateAdvisors = new Map<string, string>();
  const updateAdvisorLifecycles = new Map<string, Promise<void>>();
  // serialize launch and stop operations for one reviewed target
  const withUpdateAdvisorLifecycle = async <T>(targetSha: string, operation: () => Promise<T>): Promise<T> => {
    const previous = updateAdvisorLifecycles.get(targetSha) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(async () => await gate);
    updateAdvisorLifecycles.set(targetSha, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      // discard only the final queued lifecycle
      if (updateAdvisorLifecycles.get(targetSha) === tail) updateAdvisorLifecycles.delete(targetSha);
    }
  };
  // retain sleeping tabs during this server session
  const sleepingWorktrees = new Set<string>();
  let accountSwitching = false;
  const integrationConfig = structuredClone(config.integrations ?? defaultIntegrationConfig);
  const davoAvailable = integrationConfig.enabled && Boolean(process.env.RAC_OPENAI_API_KEY?.trim());
  // expose one secret-free voice settings snapshot
  const publicDavoSettings = () => ({ enabled: integrationConfig.realtime.enabled, available: davoAvailable, name: integrationConfig.realtime.name, context: integrationConfig.realtime.context });
  // prefer a dedicated federation secret while retaining existing deployments
  const instanceStatusSecret = process.env.RAC_INSTANCE_STATUS_SECRET ?? process.env.RAC_SESSION_SECRET ?? '';
  const instanceStatusPoller = deps.instanceStatusPoller ?? new RemoteInstanceStatusPoller(instanceStatusSecret);
  const projectProxy = new ProjectProxy(() => discovery.worktreesNow(), config.publicOrigin.origin, process.env.RAC_PROJECT_PROXY_HOST);
  const temporaryPreviewProxy = new TemporaryPreviewProxy();
  const temporaryPreviewAccess = new TemporaryPreviewAccess();
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65_536 }); const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  // The UI version is the hashed app bundle: match the module script specifically so
  // other head scripts (e.g. the pre-paint /theme-init.js) can precede it in the HTML.
  const uiVersion = async () => await readFile(join(webRoot, 'index.html'), 'utf8').then(html => /<script[^>]+type="module"[^>]+src="([^"]+)"/u.exec(html)?.[1]).catch(() => undefined); await app.register(cookie); await app.register(staticPlugin, { root: webRoot, index: false }); await app.register(rateLimit, { global: false }); await app.register(websocket, { options: { maxPayload: 65_536 } });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as { code?: unknown; statusCode?: number; message?: string };
    // normalize review parser failures
    if (request.url.includes('/review-tour') && (failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || failure.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error instanceof SyntaxError)) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    return reply.code(failure.statusCode ?? 500).send({ error: failure.message ?? 'internal error' });
  });
  app.addHook('onRequest', async (request, reply) => {
    // bypass console routing for configured project hosts
    if (projectProxy.handle(request.raw, reply.raw)) reply.hijack();
  });
  app.addHook('onReady', async () => {
    const consoleUpgradeListeners = app.server.listeners('upgrade');
    app.server.removeAllListeners('upgrade');
    // dispatch upgrades by configured host
    app.server.on('upgrade', (request, socket, head) => {
      // proxy project upgrades directly
      if (projectProxy.upgrade(request, socket, head)) return;
      // retain registered console WebSocket behavior
      for (const listener of consoleUpgradeListeners) listener.call(app.server, request, socket, head);
    });
  });
  const expectedHost = config.publicOrigin.host;
  const secureOrigin = config.publicOrigin.protocol === 'https:';
  const cookieName = secureOrigin ? '__Host-rac' : 'rac-local';
  const websocketScheme = secureOrigin ? 'wss' : 'ws';
  // allow defaults and independent checkout previews in split view
  const projectFrameSources = [...new Set(config.projects.flatMap(project => {
    // include effective overrides without allowing disabled preview origins
    return [project, ...(project.worktreeOverrides ?? [])].flatMap(preview => preview.projectUrl === undefined ? [] : [new URL(preview.projectUrl).origin]);
  }))];
  const frameSourcePolicy = `frame-src 'self'${projectFrameSources.length === 0 ? '' : ` ${projectFrameSources.join(' ')}`}`;
  const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 });
  const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const inactiveClient = () => Object.assign(new Error('another client is active'), { statusCode: 423 });
  function browser(request: FastifyRequest, mutation = false): void { if (request.headers.host !== expectedHost) throw forbidden(); if (mutation && request.headers.origin !== config.publicOrigin.origin) throw forbidden(); }
  function session(request: FastifyRequest, mutation = false): Session { browser(request, mutation); const s = auth.get(auth.unsign(request.cookies[cookieName])); if (!s) throw unauthorized(); if (mutation && !auth.csrf(s, request.headers['x-csrf-token'] as string | undefined)) throw forbidden(); return s; }
  function controlled(request: FastifyRequest, mutation = false): Session { const s = session(request, mutation); if (!control.connect(s.id)) throw inactiveClient(); return s; }
  // serve one authenticated expiring preview
  const temporaryPreview = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    browser(request);
    const token = request.params.token;
    const browserSession = auth.get(auth.unsign(request.cookies[cookieName]));
    const granted = temporaryPreviewAccess.allows(request.cookies['rac-preview'], token);
    // require either the RAC session or one path-scoped asset grant
    if (browserSession === undefined && !granted) return reply.code(401).send({ error: 'unauthorized' });
    const target = await temporaryPreviews.resolve(token);
    // hide missing, expired, and invalid registrations alike
    if (target === undefined) return reply.code(404).send({ error: 'temporary preview unavailable' });
    const prefix = `/preview/${token}`;
    const rawUrl = request.raw.url ?? `${prefix}/`;
    const expiresAt = Date.parse(target.expiresAt);
    const accessCookie = browserSession !== undefined && !granted ? temporaryPreviewCookie(temporaryPreviewAccess.issue(token, expiresAt), token, expiresAt, secureOrigin) : undefined;
    // canonicalize the preview root before proxying
    if (rawUrl === prefix || rawUrl.startsWith(`${prefix}?`)) {
      // retain the scoped grant across the redirect
      if (accessCookie !== undefined) reply.header('Set-Cookie', accessCookie);
      return reply.redirect(`${prefix}/${rawUrl.slice(prefix.length)}`);
    }
    const upstreamPath = rawUrl.slice(prefix.length) || '/';
    reply.hijack();
    temporaryPreviewProxy.handle(request.raw, reply.raw, target, upstreamPath, prefix, accessCookie);
  };
  type PublishedServer = { name: string; url: string; icon?: InstanceStatus['icon'] };
  type PublishedServerNavigation = PublishedServer & { remotes: PublishedServer[] };
  // publish configured navigation before peer checks
  const configuredRemotes = config.remoteServers.map(remote => ({ name: remote.url.hostname, url: remote.url.origin }));
  // publish safe local server metadata
  const server: PublishedServerNavigation = { name: config.name, url: config.publicOrigin.origin, ...(config.icon === undefined ? {} : { icon: config.icon }), remotes: configuredRemotes };
  // refresh remote identities from their publishers
  const refreshRemoteServers = async (known?: InstanceStatus[]) => {
    const statuses = known ?? await instanceStatusPoller.statuses(config.remoteServers);
    server.remotes = statuses.map(status => ({ name: status.name, url: status.url, ...(status.icon === undefined ? {} : { icon: status.icon }) }));
    return statuses;
  };
  // map typed review failures
  const reviewStatus = (code: ReviewErrorCode): number => {
    // map request failures
    if (code === 'invalid_request') return 400;
    // map missing targets
    if (code === 'target_unavailable') return 404;
    // map oversized snapshots
    if (code === 'too_large') return 413;
    // map invalid generator results
    if (code === 'generation_failed' || code === 'malformed_result' || code === 'generation_rejected') return 502;
    // map unavailable generator dependencies
    if (code === 'capability_unavailable' || code === 'authentication_required') return 503;
    // map bounded timeouts
    if (code === 'timed_out') return 504;
    // retain the explicit cancellation status
    if (code === 'cancelled') return 499;
    return 409;
  };
  // send one frozen review error envelope
  const reviewFailure = (reply: FastifyReply, error: unknown) => {
    const failure = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
    return reply.code(reviewStatus(failure.code)).send({ status: 'error', error: { code: failure.code, retryable: failure.retryable } });
  };
  // parse review query booleans
  const reviewQuery = (value: unknown): ReviewTourInput | undefined => {
    // require an object query
    if (value === null || typeof value !== 'object') return undefined;
    const query = value as { scope?: unknown; includeTests?: unknown; includeDocs?: unknown };
    // require the exact public query shape
    if (Object.keys(query).sort().join(',') !== 'includeDocs,includeTests,scope' || (query.includeTests !== 'true' && query.includeTests !== 'false') || (query.includeDocs !== 'true' && query.includeDocs !== 'false')) return undefined;
    return parseReviewTourInput({ scope: query.scope, includeTests: query.includeTests === 'true', includeDocs: query.includeDocs === 'true' });
  };
  // describe one authenticated browser session
  const sessionState = async (s: Session, active: boolean) => {
    // refresh peers off the authentication path
    void refreshRemoteServers().catch(() => undefined);
    const owner = control.ownerSessionId();
    return {
      csrfToken: s.csrf,
      active,
      deviceName: await devices.get(s.id),
      controllingDeviceName: owner === undefined ? undefined : await devices.get(owner),
      defaultAgent: typeof launch.defaultAgent === 'function' ? launch.defaultAgent() : undefined,
      davo: publicDavoSettings(),
      server
    };
  };
  // omit unavailable nullable limit fields
  const publicLimitWindow = (window: AccountRateLimitWindow) => ({ usedPercent: window.usedPercent, ...(window.windowDurationMins === null ? {} : { windowDurationMins: window.windowDurationMins }), ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }) });
  // flatten one secret-free account response for the browser
  const publicAccount = (account: AccountSummary) => ({
    id: account.id,
    label: account.label,
    active: account.active,
    ...(account.email === undefined ? {} : { email: account.email }),
    ...(account.planType === undefined ? {} : { planType: account.planType }),
    ...(account.limits?.primary === undefined ? {} : { primary: publicLimitWindow(account.limits.primary) }),
    ...(account.limits?.secondary === undefined ? {} : { secondary: publicLimitWindow(account.limits.secondary) }),
    ...(account.limits?.rateLimitResetCredits === undefined ? {} : { resetCount: account.limits.rateLimitResetCredits.availableCount }),
    ...(account.error === undefined ? {} : { error: account.error })
  });
  // share durable prompt queue scopes
  const promptStorageKeyForAgent = (agent: Pick<Agent, 'displayLabel' | 'id' | 'workspace'>) => {
    // isolate modal advisors from the configured repository prompt queue
    if (isUpdateAdvisorLabel(agent.displayLabel)) return `agent:${agent.id}`;
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), agent.workspace);
    return worktree === undefined ? `agent:${agent.id}` : worktree.id;
  };
  // resolve project and worktree names for one agent alert
  const notificationContextForAgent = (agent: Agent, projects: DashboardPayload['projects']): AgentNotificationContext => {
    const project = projects.find(candidate => candidate.id === agent.projectId);
    const worktree = project?.worktrees.find(candidate => candidate.id === agent.worktreeId);
    const fallbackName = agent.displayLabel ?? agent.workspace.split('/').filter(Boolean).at(-1) ?? agent.title;
    return {
      projectName: project?.label ?? fallbackName,
      worktreeName: worktree?.label ?? fallbackName,
      multipleWorktrees: (project?.worktrees.length ?? 0) > 1
    };
  };
  // count prompts before dispatch starts
  const queuedPromptCounts = async (agents: Agent[]) => new Map(await Promise.all(agents.map(async agent => {
    // suppress false completion alerts on storage errors
    const count = await queuedPrompts.list(promptStorageKeyForAgent(agent)).then(queue => queue?.length ?? 0).catch(() => 1);
    return [agent.id, count] as const;
  })));
  const dashboard = async (): Promise<DashboardPayload> => {
    const discovered = await discovery.dashboard();
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    await Promise.all(discovered.agents.map(agent => prompts.observe(agent).catch(() => undefined)));
    // suppress completions while more work waits
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0, notificationContextForAgent(agent, discovered.projects));
    notifications.retain(discovered.agents);
    const worktrees = discovery.worktreesNow();
    const controls = new Map(await Promise.all(worktrees.map(async worktree => [worktree.id, { actions: stackCommands.actions(worktree), ...await stackCommands.state(worktree) }] as const)));
    const controlFor = (worktreeId: string | undefined) => worktreeId === undefined ? undefined : controls.get(worktreeId);
    const worktreeViews = discovered.projects.flatMap(project => project.worktrees);
    const reviewBranches = worktreeViews.map(view => ({ worktreeId: view.id, branch: discovered.agents.find(agent => agent.worktreeId === view.id)?.branch ?? view.branch }));
    const reviews = await reviewStore.summaries(reviewBranches);
    // resolve the Launch profile for every scope the web can launch into: each idle
    // worktree, each running agent's worktree (for Restart as…), each non-git directory
    // Project (launched in place), and the Scratch group
    const launchResolutions = await launch.launchResolutions([scratchLaunchKey, ...worktreeViews.map(view => view.id), ...discovered.agents.flatMap(agent => agent.worktreeId === undefined ? [] : [agent.worktreeId]), ...discovered.projects.flatMap(project => project.mode === 'directory' ? [project.id] : [])]);
    const launchFor = (worktreeId: string | undefined) => launchResolutions.get(worktreeId ?? scratchLaunchKey);
    return { ...discovered, agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent), queuedPromptCount: queuedCounts.get(agent.id) ?? 0, ...(controlFor(agent.worktreeId) === undefined ? {} : { stack: controlFor(agent.worktreeId) }), ...(launchFor(agent.worktreeId) === undefined ? {} : { launch: launchFor(agent.worktreeId) }) })), projects: discovered.projects.map(project => ({ ...project, ...(project.mode === 'directory' && launchResolutions.get(project.id) !== undefined ? { launch: launchResolutions.get(project.id) } : {}), worktrees: project.worktrees.map(worktree => ({ ...worktree, ...(sleepingWorktrees.has(worktree.id) ? { sleeping: true } : {}), ...(controlFor(worktree.id) === undefined ? {} : { stack: controlFor(worktree.id) }), ...(launchFor(worktree.id) === undefined ? {} : { launch: launchFor(worktree.id) }) })) })), cleanupPending: cleanup.pending().length, scratchLaunch: launchResolutions.get(scratchLaunchKey), reviewTour: reviewTourCapability, reviews };
  };
  // observe only agent state needed by cross-instance attention
  const localInstanceAttention = async () => {
    const discovered = await discovery.dashboard();
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    // update completion and question state for every agent
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0, notificationContextForAgent(agent, discovered.projects));
    notifications.retain(discovered.agents);
    return instanceAttention({ agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent) })) });
  };
  dashboardUpdates.setLoader(dashboard);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()').header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups').header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', `default-src 'self'; connect-src 'self' ${websocketScheme}://${expectedHost}${integrationConfig.realtime.enabled ? ' https://api.openai.com' : ''}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${frameSourcePolicy}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    // publish HSTS only for HTTPS deployments
    if (secureOrigin) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  // expose the same shared services through remote transports
  if (integrationConfig.enabled) {
    const resource = `${config.publicOrigin.origin}/mcp`;
    const derivedRealtimeToken = createHmac('sha256', process.env.RAC_SESSION_SECRET ?? '').update('remote-agents:realtime-mcp:v1').digest('base64url');
    const realtimeToken = process.env.RAC_REALTIME_MCP_TOKEN?.trim() || derivedRealtimeToken;
    const integrationAuth = new IntegrationAuthService({ issuer: config.publicOrigin.origin, resource, stateFile: process.env.RAC_INTEGRATION_AUTH_FILE ?? '.data/integration-auth.json', realtimeToken, realtimeSubjectId: 'local-voice' });
    const integrationPolicy = new IntegrationPolicyService();
    const integrationAudit = new IntegrationAuditService();
    const integrationControl = new IntegrationControlService(() => control.ownerSessionId());
    await integrationPolicy.recoverUnknownOutcomes();
    const orchestration = new OrchestrationService({
      config,
      loadDashboard: () => dashboardUpdates.refresh(),
      discovery,
      tmux,
      prompts,
      promptHistory,
      worktreeCommands: stackCommands,
      workspaceFiles,
      pullRequests: prSwitch,
      newTasks: newTask,
      loadInstances: async () => {
        await refreshRemoteServers();
        return [{ id: server.url, name: server.name, url: server.url, local: true, ...(server.icon === undefined ? {} : { icon: server.icon }) }, ...server.remotes.map(remote => ({ id: remote.url, name: remote.name, url: remote.url, local: false, ...(remote.icon === undefined ? {} : { icon: remote.icon }) }))];
      },
      launchWorktree: async worktreeId => {
        const launched = await launch.launch(worktreeId);
        // clear sleep only after a successful integration launch
        if (launched) sleepingWorktrees.delete(worktreeId);
        return launched;
      },
      launchScratch: () => launch.launchHome(),
      loadReview: (worktreeId, branch) => reviewStore.current(worktreeId, branch),
      startReview: (agentId, input) => reviewJobs.start('integration-gateway', agentId, input)
    });
    const federationSecret = process.env.RAC_INTEGRATION_FEDERATION_SECRET?.trim() || instanceStatusSecret;
    const integrationGateway = new IntegrationGateway({ config: integrationConfig, instanceId: config.publicOrigin.origin, orchestration, policy: integrationPolicy, audit: integrationAudit, control: integrationControl, ...(integrationConfig.multiInstance.enabled ? { forward: federationForwarder(config.remoteServers, federationSecret) } : {}) });
    const realtimeScopes: IntegrationScope[] = ['status:read', 'logs:read', 'files:read', ...(integrationConfig.realtime.writeToolsEnabled ? ['prompts:write', 'agents:control', 'stack:operate', 'review:write'] as IntegrationScope[] : [])];
    registerIntegrationAuthServer({
      app,
      auth: integrationAuth,
      resource,
      // bind OAuth consent to the existing signed browser session
      localSubject: (request, csrf): LocalIntegrationSubject | undefined => {
        try {
          const local = session(request);
          // verify form approval with the session's CSRF secret
          if (csrf !== undefined && (request.headers.origin !== config.publicOrigin.origin || !auth.csrf(local, csrf))) return undefined;
          return { id: local.id, csrf: local.csrf } as LocalIntegrationSubject;
        } catch { return undefined; }
      }
    });
    registerMcpServer({ app, publicOrigin: config.publicOrigin.origin, auth: integrationAuth, gateway: integrationGateway, realtimeScopes });
    app.post('/api/integration-federation', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request, reply) => {
      browser(request);
      // keep cross-instance execution independently disabled
      if (!integrationConfig.multiInstance.enabled) return reply.code(404).send({ error: 'federation unavailable' });
      const delegated = verifyFederationRequest(federationSecret, request.headers['x-rac-federation-timestamp'], request.headers['x-rac-federation-signature'], request.body);
      // reject unsigned or malformed delegation
      if (delegated === undefined) return reply.code(401).send({ error: 'unauthorized' });
      return await integrationGateway.call({ authentication: 'oauth', subjectId: delegated.principal.subjectId, audience: resource, scopes: delegated.principal.scopes, ...(delegated.principal.clientId === undefined ? {} : { clientId: delegated.principal.clientId }) }, delegated.name, delegated.arguments, { voiceAuthorized: delegated.voiceAuthorized });
    });
    const realtime = new RealtimeService({ apiKey: process.env.RAC_OPENAI_API_KEY, settings: () => ({ name: integrationConfig.realtime.name, context: integrationConfig.realtime.context }) });
    app.get('/api/integrations/status', async request => {
      session(request);
      return { enabled: true, mcp: integrationConfig.mcp, control: integrationControl.snapshot(), realtime: { enabled: integrationConfig.realtime.enabled, available: integrationConfig.realtime.enabled && realtime.available(), writeToolsEnabled: integrationConfig.realtime.writeToolsEnabled } };
    });
    app.post('/api/realtime/session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const local = controlled(request, true);
      // keep voice disabled unless both the feature and provider are configured
      if (!integrationConfig.realtime.enabled || !realtime.available()) return reply.code(503).send({ error: 'Realtime voice is unavailable.' });
      const principal = integrationAuth.authenticateRealtimeToken(realtimeToken);
      // fail closed if the isolated MCP credential is unavailable
      if (!principal.ok) return reply.code(503).send({ error: 'Realtime orchestration is unavailable.' });
      const allowedTools = integrationGateway.listTools({ ...principal.value, audience: resource, scopes: realtimeScopes }).map(tool => tool.name);
      const requestedContext = body(request);
      // accept only canonical selected-target identifiers
      if ((requestedContext.worktreeId !== undefined && (typeof requestedContext.worktreeId !== 'string' || requestedContext.worktreeId.length > 240)) || (requestedContext.agentId !== undefined && (typeof requestedContext.agentId !== 'string' || requestedContext.agentId.length > 240)) || typeof requestedContext.voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/u.test(requestedContext.voiceSessionId)) return reply.code(400).send({ error: 'invalid voice context' });
      // activate mutation access only for this voice session
      if (!integrationControl.startVoice(local.id, requestedContext.voiceSessionId)) return reply.code(409).send({ error: 'voice session stopped' });
      const result = await realtime.create({ subject: local.id, mcpUrl: resource, mcpAuthorization: realtimeToken, allowedTools, context: { instanceId: config.publicOrigin.origin, ...(requestedContext.worktreeId === undefined ? {} : { worktreeId: requestedContext.worktreeId as string }), ...(requestedContext.agentId === undefined ? {} : { agentId: requestedContext.agentId as string }) } });
      // revoke access when provider setup fails
      if (!result.ok) integrationControl.stopVoice(local.id, requestedContext.voiceSessionId);
      return result.ok ? reply.send(result) : reply.code(result.code === 'invalid_request' ? 400 : 502).send({ error: result.code });
    });
    app.post('/api/realtime/session/heartbeat', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const local = controlled(request, true);
      const voiceSessionId = body(request).voiceSessionId;
      // renew only the active voice browser
      if (typeof voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/u.test(voiceSessionId) || !integrationControl.heartbeatVoice(local.id, voiceSessionId)) return reply.code(409).send({ error: 'voice mode inactive' });
      return { ok: true };
    });
    app.post('/api/realtime/session/stop', async request => {
      const local = session(request, true);
      const voiceSessionId = body(request).voiceSessionId;
      // stop only one canonical browser voice session
      if (typeof voiceSessionId === 'string' && /^[A-Za-z0-9_-]{20,64}$/u.test(voiceSessionId)) integrationControl.stopVoice(local.id, voiceSessionId);
      return { ok: true };
    });
  }
  app.get('/healthz', async () => ({ ok: true }));
  // publish only the local instance attention state
  app.get('/api/instance-status', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    browser(request);
    // require an authenticated peer signature
    if (!validInstanceStatusRequest(instanceStatusSecret, config.publicOrigin.origin, request.headers['x-rac-status-timestamp'], request.headers['x-rac-status-signature'])) return reply.code(401).send({ error: 'unauthorized' });
    return { name: server.name, ...(server.icon === undefined ? {} : { icon: server.icon }), attention: await localInstanceAttention() };
  });
  // serve the configured favicon before authentication
  app.get('/favicon.svg', async (request, reply) => { browser(request); return reply.type('image/svg+xml').send(instanceIconSvg(config.icon)); });
  // serve bundled artwork for the server menu
  app.get('/instance-icons/:icon.svg', async (request, reply) => {
    browser(request);
    const icon = (request.params as { icon: string }).icon;
    // reject unknown icon paths
    if (!isInstanceIcon(icon)) return reply.code(404).send({ error: 'icon unavailable' });
    return reply.type('image/svg+xml').send(instanceIconSvg(icon));
  });
  app.get('/preview/:token', temporaryPreview);
  app.get('/preview/:token/*', temporaryPreview);
  app.get('/', async (request, reply) => { browser(request); return reply.sendFile('index.html'); });
  app.get('/api/ui-version', async (request) => { browser(request); return { version: await uiVersion() }; });
  app.get('/api/auth/session', async (request) => { const s = session(request); return await sessionState(s, control.connect(s.id)); });
  // issue bootstrap without waiting for peers
  app.get('/api/auth/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { browser(request); void refreshRemoteServers().catch(() => undefined); return { csrfToken: auth.bootstrap(), server }; });
  // aggregate configured instance attention for authenticated clients
  app.get('/api/server-statuses', async (request) => {
    session(request);
    const [localAttention, remotes] = await Promise.all([localInstanceAttention(), instanceStatusPoller.statuses(config.remoteServers)]);
    await refreshRemoteServers(remotes);
    return { servers: [{ url: config.publicOrigin.origin, name: server.name, ...(server.icon === undefined ? {} : { icon: server.icon }), attention: localAttention }, ...remotes] };
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => { browser(request, true); const data = body(request); const preauth = request.headers['x-csrf-token']; if (typeof data.password !== 'string' || typeof preauth !== 'string') return reply.code(401).send({ error: 'invalid credentials' }); const s = await auth.login(data.password, preauth); if (!s) return reply.code(401).send({ error: 'invalid credentials' }); reply.setCookie(cookieName, auth.sign(s), { path: '/', secure: secureOrigin, httpOnly: true, sameSite: 'lax', signed: false, maxAge: 400 * 24 * 60 * 60 }); return await sessionState(s, control.connect(s.id)); });
  app.post('/api/auth/take-control', async (request, reply) => {
    const s = session(request, true);
    const providedName = body(request).deviceName;
    let deviceName = await devices.get(s.id);
    if (providedName !== undefined) {
      if (typeof providedName !== 'string' || await devices.set(s.id, providedName) === undefined) return reply.code(400).send({ error: 'Device name must be between 1 and 64 visible characters.' });
      deviceName = await devices.get(s.id);
    }
    if (deviceName === undefined) return reply.code(400).send({ error: 'Name this device before taking control.' });
    control.take(s.id);
    return await sessionState(s, true);
  });
  // rename the active browser client
  app.patch('/api/auth/device-name', async (request, reply) => {
    const s = controlled(request, true);
    const providedName = body(request).deviceName;
    // require a valid visible client name
    if (typeof providedName !== 'string' || await devices.set(s.id, providedName) === undefined) return reply.code(400).send({ error: 'Client name must be between 1 and 64 visible characters.' });
    return await sessionState(s, true);
  });
  // rename the current server persistently
  app.patch('/api/server/name', async (request, reply) => {
    controlled(request, true);
    const providedName = body(request).name;
    // require a valid configuration name
    if (typeof providedName !== 'string') return reply.code(400).send({ error: 'Server name must be between 1 and 80 visible characters.' });
    try {
      const name = await serverAdmin.renameServer(providedName);
      // reject invalid or unavailable configuration writes
      if (name === undefined) return reply.code(400).send({ error: 'Server name must be between 1 and 80 visible characters.' });
      server.name = name;
      return { name, server };
    } catch {
      return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    }
  });
  // persist the launch fallback selected by the controlling browser
  app.patch('/api/server/default-agent', async (request, reply) => {
    controlled(request, true);
    const selected = requestedKind(request);
    // require one known agent kind
    if (selected.invalid || selected.kind === undefined) return reply.code(400).send({ error: 'Choose a valid default agent.' });
    // refuse configured kinds that cannot launch now
    if (!launch.isLaunchableKind(selected.kind)) return reply.code(409).send({ error: 'The selected default agent is unavailable.' });
    let kind: AgentKind | undefined;
    try {
      kind = await serverAdmin.setDefaultAgent(selected.kind);
    } catch {
      return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    }
    // require a durable configuration write
    if (kind === undefined) return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    config.defaultAgent = kind;
    // push fresh launch resolutions without rolling back a successful preference write
    await dashboardUpdates.refresh().catch(() => undefined);
    return { defaultAgent: kind };
  });
  // publish cached current and upstream agent versions
  app.get('/api/agents/updates', async request => {
    controlled(request);
    return { agents: await agentUpdates.statuses() };
  });
  // execute one configured agent update command
  app.post('/api/agents/:kind/update', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    controlled(request, true);
    const kind = (request.params as { kind?: unknown }).kind;
    // require one registered adapter kind
    if (typeof kind !== 'string' || !(agentKinds as readonly string[]).includes(kind)) return reply.code(404).send({ error: 'Agent update is unavailable.' });
    const result = await agentUpdates.update(kind as AgentKind);
    // map service outcomes without exposing command details
    if (result.outcome === 'unavailable') return reply.code(404).send({ error: 'Agent update is unavailable.' });
    // preserve one in-flight update
    if (result.outcome === 'busy') return reply.code(409).send({ error: 'Agent update is already running.' });
    // report an operator command failure safely
    if (result.outcome === 'failed') return reply.code(502).send({ error: 'Agent update failed.' });
    return { agent: result.status };
  });
  // persist the configurable voice surface
  app.patch('/api/server/davo', async (request, reply) => {
    controlled(request, true);
    const requested = parseDavoSettings(body(request));
    // require one exact settings payload
    if (requested === undefined) return reply.code(400).send({ error: 'Choose valid Davo settings.' });
    // prevent enabling a provider surface unavailable in this process
    if (requested.enabled && !davoAvailable) return reply.code(409).send({ error: 'Davo is unavailable on this server.' });
    let saved;
    try {
      saved = await serverAdmin.setDavoSettings(requested);
    } catch {
      return reply.code(503).send({ error: 'Unable to update Davo settings.' });
    }
    // require a durable configuration write
    if (saved === undefined) return reply.code(503).send({ error: 'Unable to update Davo settings.' });
    integrationConfig.realtime = { ...integrationConfig.realtime, ...saved };
    return { davo: publicDavoSettings() };
  });
  // stop every advisor tied to one reviewed target
  const stopUpdateAdvisors = async (targetSha: string): Promise<boolean> => {
    const advisorIds = new Set<string>();
    const mappedId = updateAdvisors.get(targetSha);
    // include the in-memory target after an uninterrupted launch
    if (mappedId !== undefined) advisorIds.add(mappedId);
    let dashboard;
    try {
      dashboard = await discovery.dashboard();
    } catch {
      // never claim cleanup when pane discovery failed
      return false;
    }
    // recover every target-pinned advisor after a server restart
    for (const agent of dashboard?.agents ?? []) if (isUpdateAdvisorForTarget(agent.displayLabel, targetSha)) advisorIds.add(agent.id);
    let allClosed = true;
    // close only live server-owned advisors for this target
    for (const advisorId of advisorIds) {
      let target;
      try {
        target = await discovery.target(advisorId);
      } catch {
        // retain the mapping for a later cleanup retry
        allClosed = false;
        continue;
      }
      // treat already-vanished panes as stopped
      if (target === undefined) continue;
      // fail closed if an identifier no longer names the expected advisor
      if (!isUpdateAdvisorForTarget(target.agent.displayLabel, targetSha) || !await prompts.close(advisorId).catch(() => false)) allClosed = false;
    }
    // forget only targets with no surviving advisor
    if (allClosed) updateAdvisors.delete(targetSha);
    return allClosed;
  };
  // pull and rebuild this server on its host
  app.post('/api/server/update', { config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const expectedTargetSha = data.expectedTargetSha;
    const advisoryAcknowledged = data.advisoryAcknowledged === true;
    // reject malformed reviewed targets
    if (!isFullGitSha(expectedTargetSha)) return reply.code(400).send({ error: 'Invalid server update target.' });
    const preview = await serverAdmin.updatePreview();
    // require one fresh host preview
    if (preview === undefined) return reply.code(503).send({ error: 'Server updates are unavailable on this deployment.' });
    // stop stale modals from installing a newer revision
    if (expectedTargetSha !== preview.targetSha) return reply.code(409).send({ error: 'The upstream update changed. Review the latest commits before updating.' });
    // require operator review for flagged host changes
    if (preview.advisory.required && !advisoryAcknowledged) return reply.code(409).send({ error: 'Review and acknowledge the update advisor guidance before updating.' });
    // reject current or divergent ranges
    const retryingReviewedTarget = preview.rebuildRetryAvailable && !preview.available && preview.baseSha === expectedTargetSha && preview.targetSha === expectedTargetSha;
    // allow a failed Compose rebuild to retry after Git reached the reviewed target
    if (!preview.available && !retryingReviewedTarget) return reply.code(409).send({ error: 'The server is already current.' });
    if (!preview.fastForwardable) return reply.code(409).send({ error: 'The server checkout cannot be fast-forwarded automatically.' });
    const status = await serverAdmin.startUpdate(preview.targetSha);
    // require the configured host bridge
    if (status === undefined) return reply.code(503).send({ error: 'Server updates are unavailable on this deployment.' });
    // reject a different target already mutating this host
    if (status.kind === 'target-conflict') return reply.code(409).send({ error: `Another reviewed server update is already running for ${status.targetSha.slice(0, 7)}.` });
    return reply.code(status.state === 'failed' ? 503 : 202).send(status);
  });
  // report one surviving host update
  app.get('/api/server/update/:id', async (request, reply) => {
    controlled(request);
    const status = await serverAdmin.updateStatus((request.params as { id: string }).id);
    // retain advice through the update, then close every target pane
    if (status?.state === 'complete') await stopUpdateAdvisors(status.targetSha);
    return status === undefined ? reply.code(404).send({ error: 'Server update unavailable.' }) : status;
  });
  // check whether origin main is ahead of local main
  app.get('/api/server/update-available', async (request, reply) => {
    controlled(request);
    const preview = await serverAdmin.updatePreview();
    // require the configured host bridge
    return preview === undefined
      ? reply.code(503).send({ error: 'Server update checks are unavailable on this deployment.' })
      : { available: preview.available || preview.rebuildRetryAvailable, commitCount: preview.commitCount, targetSha: preview.targetSha };
  });
  // publish the deployed checkout revision to settings
  app.get('/api/server/revision', async (request, reply) => {
    controlled(request);
    const revision = await deployedRevision;
    // keep unavailable repository metadata explicit
    return revision === undefined ? reply.code(503).send({ error: 'Server revision is unavailable on this deployment.' }) : revision;
  });
  // preview the exact fetched update range
  app.get('/api/server/update-preview', async (request, reply) => {
    controlled(request);
    const preview = await serverAdmin.updatePreview();
    // require the configured host bridge
    return preview === undefined ? reply.code(503).send({ error: 'Server update previews are unavailable on this deployment.' }) : preview;
  });
  app.post('/api/auth/logout', async (request, reply) => { const s = session(request, true); control.release(s.id); auth.logout(s.id); reply.clearCookie(cookieName, { path: '/', secure: secureOrigin, httpOnly: true, sameSite: 'lax' }); return reply.code(204).send(); });
  app.get('/api/dashboard', async (request) => { controlled(request); return await dashboardUpdates.refresh(); });
  app.post('/api/dashboard/ticket', async (request) => { const s = controlled(request, true); return { ticket: tickets.mint(s.id, 'dashboard', 'dashboard').id }; });
  app.get('/api/cleanup', async (request) => { controlled(request); const targets = await cleanup.scan(); await dashboardUpdates.refresh().catch(() => undefined); return { targets }; });
  app.post('/api/cleanup', async (request, reply) => {
    controlled(request, true);
    const targets = await cleanup.cleanup(body(request).targetIds);
    if (targets === undefined) return reply.code(400).send({ error: 'invalid cleanup targets' });
    await dashboardUpdates.refresh().catch(() => undefined);
    return { targets };
  });
  const configuredWorktree = (id: string) => worktreeById(discovery.worktreesNow(), id);
  // notes and console-named conversations are Project-scoped: their shared key is the Worktree's projectId (ADR 0003)
  const worktreeSaveKey = (id: string) => configuredWorktree(id)?.projectId;
  // the anchor for a Schedule's displayed next-run and its firing: a restart never replays a missed
  // instant. Injectable so tests can place boot before a due instant they mean to fire.
  const scheduleBootAt = deps.scheduleBootAt ?? new Date();
  // decorate a note with its server-computed next run, so the display and the fire agree
  const decorateNote = (note: WorktreeNote) => note.schedule === undefined ? note : { ...note, nextRun: scheduleNextRun(note.schedule, scheduleBootAt)?.toISOString() };
  const decorateNotes = (stored: WorktreeNote[]) => stored.map(decorateNote);
  // resolve a Schedule notification's operator-facing "<Project | Scratch>" label and, for a Worktree
  // target, its wire id (the service worker deep-links to the Worktree). A Worktree resolves to its
  // Project's label; a gone Worktree falls back to a generic word so a "target is gone" skip still notifies.
  const resolveScheduleTarget = (target: ScheduleTarget): { label: string; worktreeId?: string } => {
    if ('scratch' in target) return { label: 'Scratch' };
    if ('worktreeId' in target) {
      const worktree = configuredWorktree(target.worktreeId);
      return { label: config.projects.find(project => project.id === worktree?.projectId)?.label ?? worktree?.label ?? 'a worktree', worktreeId: target.worktreeId };
    }
    return { label: config.projects.find(project => project.id === target.projectId)?.label ?? 'a project' };
  };
  // validate a set-schedule body into a Schedule, or return the operator-facing reason it was refused;
  // launchability is checked at Run time, since configuration can change — here only existence and shape
  const buildSchedule = (raw: Record<string, unknown>): Schedule | string => {
    if (typeof raw.cron !== 'string' || raw.cron.length > 200) return 'invalid cron expression';
    const error = cronError(raw.cron);
    if (error !== undefined) return error;
    if (typeof raw.kind !== 'string' || !(agentKinds as readonly string[]).includes(raw.kind)) return 'unknown agent kind';
    const target = raw.target;
    if (!validScheduleTarget(target)) return 'invalid schedule target';
    if ('worktreeId' in target && configuredWorktree(target.worktreeId) === undefined) return 'target worktree not found';
    if ('projectId' in target) {
      const projectId = target.projectId;
      const project = config.projects.find(candidate => candidate.id === projectId);
      if (project === undefined || !project.available || project.mode !== 'directory') return 'target project unavailable';
    }
    if (typeof raw.enabled !== 'boolean') return 'invalid enabled flag';
    return { cron: raw.cron, kind: raw.kind as AgentKind, target, enabled: raw.enabled, updatedAt: new Date().toISOString() };
  };
  // resolve durable persistence for one live agent
  const agentPersistence = async (id: string) => {
    const target = await discovery.target(id);
    // require one current agent target
    if (target === undefined) return undefined;
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    return { agent: target.agent, worktree, saveKey: worktree?.projectId ?? scratchSaveKey(target.agent.workspace) };
  };
  // map a halted queue's scope to its Notes key (the Project id, or the hashed Scratch key), so a
  // drained prompt lands in the same note group the agent's own notes use. A Worktree scope
  // `<projectId>:<realpath>` collapses to its Project id; a Scratch scope resolves through the live
  // agent. A gone agent yields no key, leaving the prompt queued and the queue halted.
  const noteKeyForQueueScope = async (scope: string): Promise<string | undefined> =>
    scope.startsWith('agent:') ? (await agentPersistence(scope.slice('agent:'.length)))?.saveKey : projectIdOf(scope);
  // the PromptService's drain sink: each prompt from a halted queue becomes an "Undelivered prompt"
  // Note (attachments named in the text, not kept). A false return keeps the prompt queued and the
  // queue halted, exactly as the retired saved-prompts hand-off did.
  const drainUndelivered = async (scope: string, prompt: QueuedPrompt): Promise<boolean> => {
    const key = await noteKeyForQueueScope(scope);
    if (key === undefined) return false;
    const { title, text } = promptNoteContent('Undelivered prompt', new Date(), prompt);
    return await notes.createWithText(key, title, text) !== undefined;
  };
  // resolve the observed branch for one configured worktree
  const reviewBranch = async (id: string): Promise<string | undefined> => {
    const discovered = await discovery.dashboard();
    return discovered.agents.find(agent => agent.worktreeId === id)?.branch ?? discovered.projects.flatMap(project => project.worktrees).find(worktree => worktree.id === id)?.branch;
  };
  app.get('/api/worktrees/:id/notes', async (request, reply) => { controlled(request); const id = (request.params as { id: string }).id; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const stored = await notes.list(saveKey); return stored === undefined ? reply.code(400).send({ error: 'invalid worktree' }) : { notes: decorateNotes(stored) }; });
  // pin or unpin one Worktree so an idle checkout keeps (or drops) its tab; the override
  // is stored in `.data`, discovery re-reads it on the next tick
  app.post('/api/worktrees/:id/pin', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const pinned = body(request).pinned;
    // require one known Worktree and an explicit pin state
    if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    if (typeof pinned !== 'boolean') return reply.code(400).send({ error: 'invalid pin state' });
    await worktreeStore.setPinned(id, pinned);
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // set or clear one Worktree's durable display label
  app.patch('/api/worktrees/:id/label', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const requestedLabel = body(request).label;
    // require one known Worktree before writing operator state
    if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // null restores the generated Project/branch label
    if (requestedLabel !== null && typeof requestedLabel !== 'string') return reply.code(400).send({ error: 'invalid worktree label' });
    const label = typeof requestedLabel === 'string' ? requestedLabel.trim() : undefined;
    // keep labels bounded and single-line
    if (label !== undefined && (label.length === 0 || label.length > 120 || /[\0-\x1f\x7f]/u.test(label))) return reply.code(400).send({ error: 'invalid worktree label' });
    await worktreeStore.setLabel(id, label);
    discovery.invalidateWorktrees();
    // publish independently so a slow dashboard scan never blocks the saved response
    void dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // create an optionally titled note
  app.post('/api/worktrees/:id/notes', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const saveKey = worktreeSaveKey(id); const title = body(request).title; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0'))) return reply.code(400).send({ error: 'invalid note title' }); const note = await notes.create(saveKey, title as string | undefined); return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(note); });
  app.put('/api/worktrees/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); const text = body(request).text; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' }); const note = await notes.update(saveKey, noteId, text); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  // rename one note
  app.patch('/api/worktrees/:id/notes/:noteId', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); const title = body(request).title; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid note title' }); const note = await notes.rename(saveKey, noteId, title); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  app.delete('/api/worktrees/:id/notes/:noteId', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const note = await notes.delete(saveKey, noteId); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  // set or replace one note's Schedule
  app.put('/api/worktrees/:id/notes/:noteId/schedule', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const schedule = buildSchedule(body(request)); if (typeof schedule === 'string') return reply.code(400).send({ error: schedule }); const note = await notes.setSchedule(saveKey, noteId, schedule); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : decorateNote(note); });
  // remove one note's Schedule, keeping the note
  app.delete('/api/worktrees/:id/notes/:noteId/schedule', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const note = await notes.removeSchedule(saveKey, noteId); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : decorateNote(note); });
  // run one worktree note's Schedule now, exactly as the scheduler will
  app.post('/api/worktrees/:id/notes/:noteId/schedule/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); return await runScheduleNow(saveKey, noteId, reply); });
  // list one live agent's notes
  app.get('/api/agents/:id/notes', async (request, reply) => {
    controlled(request);
    const persistence = await agentPersistence((request.params as { id: string }).id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const stored = await notes.list(persistence.saveKey);
    return stored === undefined ? reply.code(400).send({ error: 'invalid note group' }) : { notes: decorateNotes(stored) };
  });
  // create one live agent note
  app.post('/api/agents/:id/notes', async (request, reply) => {
    controlled(request, true);
    const persistence = await agentPersistence((request.params as { id: string }).id);
    const title = body(request).title;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require one bounded optional title
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0'))) return reply.code(400).send({ error: 'invalid note title' });
    const note = await notes.create(persistence.saveKey, typeof title === 'string' ? title : undefined);
    return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(note);
  });
  // update one live agent note
  app.put('/api/agents/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const text = body(request).text;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require bounded note content
    if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' });
    const note = await notes.update(persistence.saveKey, noteId, text);
    return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note;
  });
  // rename one live agent note
  app.patch('/api/agents/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const title = body(request).title;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require one bounded title
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid note title' });
    const note = await notes.rename(persistence.saveKey, noteId, title);
    return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note;
  });
  // delete one live agent note
  app.delete('/api/agents/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const note = await notes.delete(persistence.saveKey, noteId);
    return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note;
  });
  // set or replace one live agent note's Schedule
  app.put('/api/agents/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const schedule = buildSchedule(body(request));
    if (typeof schedule === 'string') return reply.code(400).send({ error: schedule });
    const note = await notes.setSchedule(persistence.saveKey, noteId, schedule);
    return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : decorateNote(note);
  });
  // remove one live agent note's Schedule, keeping the note
  app.delete('/api/agents/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const note = await notes.removeSchedule(persistence.saveKey, noteId);
    return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : decorateNote(note);
  });
  // run one live agent note's Schedule now, exactly as the scheduler will
  app.post('/api/agents/:id/notes/:noteId/schedule/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    return await runScheduleNow(persistence.saveKey, noteId, reply);
  });
  // preview a cron expression's next three instants in the console's own zone
  app.get('/api/schedule/preview', async (request, reply) => {
    controlled(request);
    const cron = (request.query as { cron?: unknown }).cron;
    if (typeof cron !== 'string' || cron.length > 200) return reply.code(400).send({ error: 'invalid cron expression' });
    const error = cronError(cron);
    if (error !== undefined) return reply.code(400).send({ error });
    return { next: (previewRuns(cron, new Date(), 3) ?? []).map(run => run.toISOString()) };
  });
  // the current Conversation id of a live agent, but only when it is open on this very
  // Worktree — a sibling-Worktree agent, a stale agentId, or an unresolvable Conversation
  // marks nothing current (used by the conversations listing route)
  const currentConversationOnWorktree = async (worktreeId: string, agentId: string): Promise<string | undefined> => {
    const target = await discovery.target(agentId);
    const targetWorktree = target === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    return targetWorktree?.id === worktreeId ? discovery.conversationId(agentId) : undefined;
  };
  // a Project's current Worktree directories mapped to their Worktree id: the host-visible
  // checkout root each Conversation is started in (the cwd an Adapter's `list` scans and
  // reports on each row), so a listed row's directory resolves back to its Worktree
  const projectConversationScope = (projectId: string): Map<string, string> => {
    const scope = new Map<string, string>();
    for (const worktree of discovery.worktreesNow()) if (worktree.projectId === projectId) scope.set(worktreeHostRoot(worktree), worktree.id);
    return scope;
  };
  // list the Named conversations under these directories, resolve each row's Worktree, whether it
  // is the current one, and whether the console named it, and order the union newest-active first.
  // Codex and OMX share one rollout reader (ADR 0005), so the union emits a single codex-family row
  // per rollout; the console badges it with the Worktree's remembered Launch kind when that is codex
  // or omx, else codex (a Claude/Pi Worktree that also holds a Codex rollout still shows it as Codex).
  // the kind a shared codex-family rollout resumes under on one Worktree: its remembered
  // Launch kind when that is itself codex or omx, else Codex — the per-Worktree form of the
  // attribution `listConversations` applies across the whole list
  const rememberedCodexKind = async (worktreeId: string): Promise<AgentKind> => {
    const remembered = await worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    const kind = remembered[worktreeId];
    return kind !== undefined && codexFamily(kind) ? kind : 'codex';
  };
  // whether a listed row is one the console named: an intersection with the record store, so a
  // Conversation the agent no longer lists disappears with it (codex-family matched by id, ADR 0005)
  const rowConsoleNamed = (records: readonly ConsoleNamedConversation[], row: { kind: AgentKind; id: string }): boolean =>
    records.some(record => sameConversation(record, row));
  const listConversations = async (directories: readonly string[], scope: Map<string, string>, currentId: string | undefined, consoleNamedRecords: readonly ConsoleNamedConversation[]): Promise<ConversationRow[]> => {
    const listed = await discovery.conversations(directories);
    // read remembered kinds once, only when a codex-family row needs attributing
    const remembered = listed.some(row => codexFamily(row.kind))
      ? await worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>))
      : {};
    const rows: ConversationRow[] = listed.map(row => {
      const worktreeId = scope.get(row.directory);
      const rememberedKind = worktreeId === undefined ? undefined : remembered[worktreeId];
      // a shared codex-family row follows the Worktree's remembered kind only when that is
      // itself codex or omx; anything else (Claude/Pi/unset) leaves the rollout badged Codex
      const kind = codexFamily(row.kind) ? (rememberedKind !== undefined && codexFamily(rememberedKind) ? rememberedKind : 'codex') : row.kind;
      return {
        kind,
        id: row.id,
        name: row.name,
        ...(row.automatic === undefined ? {} : { automatic: row.automatic }),
        lastActiveAt: row.lastActiveAt,
        directory: row.directory,
        ...(worktreeId === undefined ? {} : { worktreeId }),
        consoleNamed: rowConsoleNamed(consoleNamedRecords, { kind: row.kind, id: row.id }),
        current: currentId !== undefined && row.id === currentId,
      };
    });
    rows.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    return rows;
  };
  // the scan scope and directories for one live agent: its whole Project's Worktree host roots,
  // or just its own directory for a Scratch agent that has no Worktree to resume into
  const agentConversationScope = (persistence: NonNullable<Awaited<ReturnType<typeof agentPersistence>>>): { scope: Map<string, string>; directories: string[] } => {
    const scope = persistence.worktree === undefined ? new Map<string, string>() : projectConversationScope(persistence.worktree.projectId);
    return { scope, directories: persistence.worktree === undefined ? [persistence.agent.workspace] : [...scope.keys()] };
  };
  // list one Worktree's Project-wide Named conversations (every kind, every Worktree of the
  // Project); an optional live agent open on this Worktree marks the current row
  app.get('/api/worktrees/:id/conversations', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const agentId = (request.query as { agentId?: unknown }).agentId;
    const worktree = configuredWorktree(id);
    // require one configured Worktree
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // reject malformed agent context
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) return reply.code(400).send({ error: 'invalid agent' });
    const scope = projectConversationScope(worktree.projectId);
    // resolve the current Conversation only for a live agent open on this very Worktree
    const currentId = typeof agentId === 'string' ? await currentConversationOnWorktree(id, agentId) : undefined;
    // a failed record read degrades to "nothing console-named" rather than dropping the list
    const records = await consoleNamed.list(worktree.projectId).catch(() => undefined) ?? [];
    const conversations = await listConversations([...scope.keys()], scope, currentId, records);
    return { conversations, canResume: launch.canResumeConversation(id) };
  });
  // list one live agent's Named conversations: its whole Project when it belongs to a
  // Worktree, or just its own directory for a Scratch agent (no Worktree to resume into)
  app.get('/api/agents/:id/conversations', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const persistence = await agentPersistence(id);
    // require one current agent target
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const { scope, directories } = agentConversationScope(persistence);
    const currentId = await discovery.conversationId(id);
    // a failed record read degrades to "nothing console-named" rather than dropping the list
    const records = await consoleNamed.list(persistence.saveKey).catch(() => undefined) ?? [];
    const conversations = await listConversations(directories, scope, currentId, records);
    return { conversations, canResume: persistence.worktree !== undefined && launch.canResumeConversation(persistence.worktree.id) };
  });
  // name the current Conversation from the console: submit the CLI's own rename command into the
  // pane (bypassing the prompt service — no history entry, no queued-prompt phase), confirm the
  // name from the agent's own store, then record that the console named it (ADR 0007). The name
  // itself lives only in the agent's store; the console keeps `{ kind, id, namedAt }`.
  app.post('/api/agents/:id/conversations/name', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const requestedName = body(request).name;
    // require one bounded, single-line name with no control characters
    if (typeof requestedName !== 'string') return reply.code(400).send({ error: 'invalid conversation name' });
    const trimmed = requestedName.trim();
    if (trimmed.length === 0 || trimmed.length > 120 || /[\0-\x1f\x7f]/u.test(trimmed)) return reply.code(400).send({ error: 'invalid conversation name' });
    // the agents' own stores collapse runs of whitespace when they read a name back, so collapse
    // here too — otherwise the read-back of a name with interior double spaces never confirms
    const name = trimmed.replace(/\s+/gu, ' ');
    const persistence = await agentPersistence(id);
    // require one live agent
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const conversations = adapterFor(persistence.agent.kind)?.conversations;
    // require an Adapter that both renames and reads the name back
    if (conversations?.rename === undefined || conversations.readName === undefined) return reply.code(409).send({ error: 'This agent cannot be named from the console.' });
    // one rename in flight per agent: a second pasted rename would race the first's read-back
    if (renamesInFlight.has(id)) return reply.code(409).send({ error: 'A rename is already in progress for this conversation.' });
    renamesInFlight.add(id);
    try {
      // refuse while a question dialog owns the keyboard — it would swallow the pasted rename.
      // force a fresh dashboard: this is a safety gate immediately before terminal input, so a
      // stale snapshot must not let the rename paste into a question that just appeared
      const observed = (await discovery.dashboard(true).catch(() => undefined))?.agents.find(agent => agent.id === id);
      if (observed !== undefined && agentAttentionState(observed) === 'question') return reply.code(409).send({ error: 'Answer the agent\'s question before naming this conversation.' });
      // require a known current Conversation to rename and to read back
      const conversationId = await discovery.conversationId(id);
      if (conversationId === undefined) return reply.code(409).send({ error: 'The current conversation is unknown.' });
      const target = await discovery.target(id);
      if (target === undefined) return reply.code(404).send({ error: 'agent unavailable' });
      // hold the agent's lifecycle mutation lock across the paste so a concurrent restart/switch
      // cannot close the pane mid-delivery (and so it, in turn, defers to this rename), exactly as
      // prompt submission does; a live restart reservation refuses the rename
      const releaseMutation = prompts.beginAgentMutation(id);
      if (releaseMutation === undefined) return reply.code(409).send({ error: 'The agent is busy with another operation.' });
      const rename = conversations.rename(name);
      const buffer = `rac-${randomBytes(18).toString('base64url')}`;
      try {
        // paste the Adapter's rename text and send its keys directly on the pane (Enter in every state)
        if (!await tmux.pastePrompt(target.socket, target.agent.paneId, buffer, rename.text)
          || !await tmux.sendKeys(target.socket, target.agent.paneId, rename.keys)) return reply.code(502).send({ error: 'Could not deliver the rename to the agent.' });
      } finally { releaseMutation(); }
      // read the name back from the agent's own store until it reports the submitted name
      const cwd = discovery.paneWorkingDirectory(id);
      let confirmed = false;
      for (let attempt = 0; attempt < conversationNamePollAttempts; attempt += 1) {
        await conversationNamePollDelay();
        const current = await conversations.readName(conversationId, cwd).catch(() => undefined);
        if (current === name) { confirmed = true; break; }
      }
      // the name may still have applied (it will show under All named), but the quick list is
      // "what I confirmed here", so an unconfirmed rename records nothing
      if (!confirmed) return reply.code(409).send({ error: 'The agent did not confirm the name.' });
      // the rename already applied and confirmed; a failed record write (a corrupt or locked store)
      // must not 500 the request — the row simply won't be console-named until the next successful name
      await consoleNamed.record(persistence.saveKey, { kind: persistence.agent.kind, id: conversationId }).catch(() => undefined);
      // return the freshly-listed row for the named Conversation (now console-named and current)
      const { scope, directories } = agentConversationScope(persistence);
      const stored = await consoleNamed.list(persistence.saveKey).catch(() => undefined) ?? [];
      const rows = await listConversations(directories, scope, conversationId, stored);
      const row = rows.find(candidate => sameConversation(candidate, { kind: persistence.agent.kind, id: conversationId }));
      return reply.code(201).send({ conversation: row });
    } finally {
      renamesInFlight.delete(id);
    }
  });
  // forget the console's record of one Conversation (Worktree-scoped, by kind and id). The
  // transcript and its name survive; the row leaves the quick list and stays under All named.
  app.delete('/api/worktrees/:id/conversations/:kind/:conversationId', async (request, reply) => {
    controlled(request, true);
    const { id, kind, conversationId } = request.params as { id: string; kind: string; conversationId: string };
    const saveKey = worktreeSaveKey(id);
    // require one configured Worktree group
    if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // reject an unknown kind
    if (!agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const removed = await consoleNamed.remove(saveKey, kind as AgentKind, conversationId);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: 'conversation record unavailable' });
  });
  // the agent-scoped twin: a Scratch agent's records key to its workspace, not a Project
  app.delete('/api/agents/:id/conversations/:kind/:conversationId', async (request, reply) => {
    controlled(request, true);
    const { id, kind, conversationId } = request.params as { id: string; kind: string; conversationId: string };
    const persistence = await agentPersistence(id);
    // require one live agent
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // reject an unknown kind
    if (!agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const removed = await consoleNamed.remove(persistence.saveKey, kind as AgentKind, conversationId);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: 'conversation record unavailable' });
  });
  // preview one configured worktree file
  app.post('/api/worktrees/:id/file-preview', async (request, reply) => {
    controlled(request, true);
    const { id } = request.params as { id: string };
    const path = body(request).path;
    // require one bounded relative path
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const worktree = configuredWorktree(id);
    // require a configured workspace
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const preview = await workspaceFiles.preview(worktree.identity, path);
    return preview === undefined ? reply.code(404).send({ error: 'file unavailable' }) : preview;
  });
  app.get('/api/push/public-key', async (request) => { session(request); return push.enabled ? { publicKey: push.publicKey } : { publicKey: undefined }; });
  app.post('/api/push/subscriptions', async (request, reply) => { session(request, true); return await push.subscribe(body(request) as never) ? reply.code(204).send() : reply.code(400).send({ error: 'invalid push subscription' }); });
  app.post('/api/agents/:id/notifications/dismiss', async (request, reply) => {
    controlled(request, true);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    const scopedAgent = worktree === undefined ? target.agent : { ...target.agent, worktreeId: worktree.id };
    notifications.view(scopedAgent);
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/switch-prs', async (request, reply) => { controlled(request); const availability = await prSwitch.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'pull request switching unavailable' }) : availability; });
  app.get('/api/agents/:id/github-actions', async (request, reply) => { controlled(request); const url = await prSwitch.actionsUrl((request.params as { id: string }).id); return url === undefined ? reply.code(404).send({ error: 'GitHub Actions unavailable' }) : { url }; });
  app.post('/api/agents/:id/switch-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number) || !await prSwitch.switch((request.params as { id: string }).id, number as number)) return reply.code(409).send({ error: 'Unable to switch to that pull request. The worktree must be clean and pushed.' }); return reply.code(202).send(); });
  // move one occupied pull request into the requested agent worktree
  app.post('/api/agents/:id/move-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number)) return reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); const result = await prSwitch.move((request.params as { id: string }).id, number as number); if (result === 'recovery-required') return reply.code(409).send({ error: 'The pull request move needs manual recovery. Check both worktrees; any unrecovered changes remain safely stored in Git stash.', recoveryRequired: true }); return result === 'moved' ? reply.code(202).send() : reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); });
  app.post('/api/agents/:id/switch-branch', async (request, reply) => { controlled(request, true); const branch = body(request).branch; if (typeof branch !== 'string' || !await prSwitch.switchBranch((request.params as { id: string }).id, branch)) return reply.code(409).send({ error: 'Unable to switch to that branch. The worktree must be clean and pushed.' }); return reply.code(202).send(); });
  // move one occupied local branch into the requested agent worktree
  app.post('/api/agents/:id/move-branch', async (request, reply) => { controlled(request, true); const branch = body(request).branch; if (typeof branch !== 'string') return reply.code(409).send({ error: 'Unable to move that branch. The destination must be clean and the source branch must still be open in another worktree.' }); const result = await prSwitch.moveBranch((request.params as { id: string }).id, branch); if (result === 'recovery-required') return reply.code(409).send({ error: 'The branch move needs manual recovery. Check both worktrees; any unrecovered changes remain safely stored in Git stash.', recoveryRequired: true }); return result === 'moved' ? reply.code(202).send() : reply.code(409).send({ error: 'Unable to move that branch. The destination must be clean and the source branch must still be open in another worktree.' }); });
  app.get('/api/agents/:id/new-task', async (request, reply) => { controlled(request); const availability = await newTask.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'new task unavailable' }) : availability; });
  app.post('/api/agents/:id/new-task', async (request, reply) => { controlled(request, true); if (!await newTask.start((request.params as { id: string }).id)) return reply.code(409).send({ error: 'Unable to start a new task. The working copy must be clean and pushed.' }); return reply.code(202).send(); });
  const promptStorageKey = async (agentId: string) => {
    const target = await discovery.target(agentId);
    if (!target) return undefined;
    return promptStorageKeyForAgent(target.agent);
  };
  app.post('/api/agents/:id/prompt', { bodyLimit: Math.ceil(maxPromptAttachmentBytes * 1.4) }, async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const attachments = promptAttachments(data.attachments);
    if (typeof data.prompt !== 'string' || attachments === undefined || !validPrompt(data.prompt, attachments)) return reply.code(400).send({ error: 'invalid prompt' });
    if (!await prompts.submit((request.params as { id: string }).id, data.prompt, attachments)) return reply.code(404).send({ error: 'target unavailable' });
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/prompt-history', async (request, reply) => { controlled(request); const key = await promptStorageKey((request.params as { id: string }).id); if (key === undefined) return reply.code(404).send({ error: 'target unavailable' }); const prompts = await promptHistory.list(key); return prompts === undefined ? reply.code(400).send({ error: 'invalid prompt history scope' }) : { prompts }; });
  app.get('/api/agents/:id/queued-prompts', async (request, reply) => { controlled(request); const queued = await prompts.listQueued((request.params as { id: string }).id); return queued === undefined ? reply.code(404).send({ error: 'target unavailable' }) : { prompts: queued }; });
  app.put('/api/agents/:id/queued-prompts/:promptId', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; const text = body(request).prompt; if (typeof text !== 'string') return reply.code(400).send({ error: 'invalid prompt' }); const prompt = await prompts.updateQueued(id, promptId, text); return prompt === undefined ? reply.code(404).send({ error: 'queued prompt unavailable' }) : prompt; });
  app.post('/api/agents/:id/queued-prompts/:promptId/move', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; const direction = body(request).direction; if (direction !== 'earlier' && direction !== 'later') return reply.code(400).send({ error: 'invalid queue direction' }); const queued = await prompts.moveQueued(id, promptId, direction); return queued === undefined ? reply.code(404).send({ error: 'queued prompt unavailable' }) : { prompts: queued }; });
  app.delete('/api/agents/:id/queued-prompts/:promptId', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; return await prompts.removeQueued(id, promptId) ? reply.code(204).send() : reply.code(404).send({ error: 'queued prompt unavailable' }); });
  app.get('/api/agents/:id/commands', async (request, reply) => {
    controlled(request);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const adapter = adapterFor(target.agent.kind);
    // an Adapter without a command catalog serves an empty one
    if (adapter === undefined) return { commands: [] };
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    // the Adapter resolves its own state directory (its skills root) from the environment
    const stateDirectory = adapter.commands?.stateDirectory() ?? '';
    return { commands: await commandCatalog.catalog(adapter, worktree?.path ?? target.agent.workspace, stateDirectory) };
  });
  // list workspace files referenced by one completed response
  app.post('/api/agents/:id/message-files', async (request, reply) => {
    controlled(request, true);
    const message = body(request).message;
    if (typeof message !== 'string' || message.length > 30_000 || message.includes('\0')) return reply.code(400).send({ error: 'invalid assistant message' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    return { files: await workspaceFiles.list(worktree?.identity ?? target.agent.workspace, message) };
  });
  // preview one workspace file or bounded host temporary screenshot
  app.post('/api/agents/:id/file-preview', async (request, reply) => {
    controlled(request, true);
    const path = body(request).path;
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    const panePid = discovery.paneProcessId(target.agent.id);
    // fall back only to the image-only host temporary bridge
    const preview = await workspaceFiles.preview(worktree?.identity ?? target.agent.workspace, path) ?? await workspaceFiles.previewTemporaryImage(path, panePid);
    return preview === undefined ? reply.code(404).send({ error: 'file unavailable' }) : preview;
  });
  // save a queued prompt as a Note under the agent's note key, consuming the queued copy only once
  // the Note is durable; attachments are dropped and named in the note text
  app.post('/api/agents/:id/queued-prompts/:promptId/save', async (request, reply) => {
    controlled(request, true);
    const { id, promptId } = request.params as { id: string; promptId: string };
    const [queueKey, persistence] = await Promise.all([promptStorageKey(id), agentPersistence(id)]);
    if (queueKey === undefined || persistence === undefined) return reply.code(404).send({ error: 'target unavailable' });
    let note: WorktreeNote | undefined;
    const result = await queuedPrompts.consumeOnSuccess(queueKey, promptId, async queued => {
      const content = promptNoteContent('Queued prompt', new Date(), queued);
      note = await notes.createWithText(persistence.saveKey, content.title, content.text);
      return note !== undefined;
    });
    if (result === 'missing') return reply.code(404).send({ error: 'queued prompt unavailable' });
    if (result === 'failed' || note === undefined) return reply.code(409).send({ error: 'unable to save queued prompt' });
    return reply.code(201).send(note);
  });
  app.post('/api/agents/:id/cancel', async (request, reply) => { controlled(request, true); const outcome = await prompts.cancel((request.params as { id: string }).id); if (outcome === 'unavailable') return reply.code(404).send({ error: 'target unavailable' }); if (outcome === 'not-working') return reply.code(409).send({ error: 'The agent is not working; there is nothing to interrupt.' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/background', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (!target || !await tmux.suspend(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/review-tour/jobs', { bodyLimit: REVIEW_REQUEST_BODY_BYTES }, async (request, reply) => {
    const owner = controlled(request, true).id;
    const input = parseReviewTourInput(request.body);
    const requestIdHeader = request.headers['idempotency-key'];
    const requestId = requestIdHeader === undefined ? undefined : parseReviewRequestId(requestIdHeader);
    // reject malformed review requests
    if (input === undefined || requestIdHeader !== undefined && requestId === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    try {
      const started = await reviewJobs.start(owner, (request.params as { id: string }).id, input, requestId);
      // return empty selections without a job
      if (started.kind === 'empty') return reply.code(200).send({ status: 'empty', snapshot: started.snapshot });
      return reply.code(202).send({ status: 'pending', job: started.job });
    } catch (error) { return reviewFailure(reply, error); }
  });
  app.get('/api/agents/:id/review-tour/fingerprint', async (request, reply) => {
    controlled(request);
    const input = reviewQuery(request.query);
    // reject malformed fingerprint queries
    if (input === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    try {
      const current = await reviewTours.fingerprint((request.params as { id: string }).id, input);
      return reply.code(200).send({ status: current.empty ? 'empty' : 'snapshot', snapshot: current.snapshot });
    } catch (error) { return reviewFailure(reply, error); }
  });
  app.get('/api/review-tour/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request).id;
    const job = reviewJobs.get(owner, (request.params as { jobId: string }).jobId);
    // hide missing or cross-owner jobs
    if (job === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    // map every frozen job state
    if (job.state.kind === 'pending') return reply.code(202).send({ status: 'pending', job: { id: job.id, expiresAt: new Date(job.expiresAt).toISOString(), retryAfterMs: 1_000 } });
    if (job.state.kind === 'ready') return reply.code(200).send({ status: 'ready', tour: job.state.tour });
    if (job.state.kind === 'empty') return reply.code(200).send({ status: 'empty', snapshot: job.state.snapshot });
    if (job.state.kind === 'gone') return reply.code(410).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: true } });
    return reply.code(reviewStatus(job.state.code)).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: job.state.retryable } });
  });
  app.delete('/api/review-tour/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request, true).id;
    // cancel only owner-scoped jobs
    return reviewJobs.cancel(owner, (request.params as { jobId: string }).jobId) ? reply.code(204).send() : reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
  });
  app.get('/api/worktrees/:id/review-tour', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    // require a configured worktree
    if (configuredWorktree(id) === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    const review = await reviewStore.current(id, await reviewBranch(id));
    // hide missing and branch-invalidated reviews
    return review === undefined ? reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } }) : reply.code(200).send({ status: 'ready', review });
  });
  app.delete('/api/worktrees/:id/review-tour', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    // require a configured worktree
    if (configuredWorktree(id) === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    await reviewStore.dismiss(id);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.post('/api/agents/:id/foreground', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (!target || !await tmux.foreground(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.delete('/api/agents/:id', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || discovery.worktreesNow().some(worktree => worktreeMatchesWorkspace(worktree, target.agent.workspace)) || !await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  // permanently close one idle configured agent
  app.post('/api/agents/:id/deactivate', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const target = await discovery.target(id);
    const worktree = target === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    // preserve active configured agents
    if (!target || worktree === undefined || agentAttentionState(target.agent) === 'working') return reply.code(409).send({ error: 'only idle configured agents can be turned off' });
    // require a live target
    if (!await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' });
    sleepingWorktrees.delete(worktree.id);
    return reply.code(204).send();
  });
  // close one idle agent while retaining its worktree tab
  app.post('/api/agents/:id/sleep', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const target = await discovery.target(id);
    const worktree = target === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
    // limit sleep to the same idle configured agents as turn off
    if (!target || worktree === undefined || agentAttentionState(target.agent) === 'working') return reply.code(409).send({ error: 'only idle configured agents can sleep' });
    // require a live target
    if (!await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' });
    sleepingWorktrees.add(worktree.id);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.post('/api/agents/:id/question', async (request, reply) => { controlled(request, true); const data = body(request); if (typeof data.questionId !== 'string' || !Number.isInteger(data.index) || !await prompts.answerQuestion((request.params as { id: string }).id, data.questionId, data.index as number)) return reply.code(404).send({ error: 'question unavailable' }); return reply.code(204).send(); });
  // delay between launch checks
  const launchPollDelay = deps.launchPollDelay ?? defaultLaunchPollDelay;
  // read-back after a console rename: poll the agent's own store every 200 ms for ~1.5 s until
  // it reports the submitted name (the probe saw a rename apply within ~200 ms, idle or mid-turn)
  const conversationNamePollIntervalMs = 200;
  const conversationNamePollAttempts = 8;
  const conversationNamePollDelay = deps.conversationNamePollDelay ?? (async () => await new Promise(resolve => setTimeout(resolve, conversationNamePollIntervalMs)));
  // agents with a console rename in flight, so a second concurrent rename is refused
  const renamesInFlight = new Set<string>();
  // wait for slow agent startup, shared with the Run primitive (launch/wait.ts)
  const waitForAgent = createAgentWaiter(discovery, launchPollDelay);
  // the pane snapshot an Adapter's `newConversation` rules read, from one discovered agent
  // (Scheduled prompts) — the single builder the readiness poll and the reset settle loop share
  const runSnapshot = (agent: Agent): PaneSnapshot => ({ title: agent.title, attention: agentAttentionState(agent), ...(agent.conversationId === undefined ? {} : { conversationId: agent.conversationId }) });
  // wait for a freshly launched pane to become ready for its first prompt, reading the
  // launching Adapter's `ready` rule over the pane's snapshot and capture (Scheduled
  // prompts). A kind without a new-conversation capability takes its first prompt at once.
  type ReadinessOutcome = { state: 'ready' } | { state: 'blocked'; reason: string } | { state: 'timed-out' };
  const waitForReadiness = async (agent: Agent): Promise<ReadinessOutcome> => {
    const ready = adapterFor(agent.kind)?.newConversation?.ready;
    // no readiness rule: the fresh launch may take its first prompt immediately
    if (ready === undefined) return { state: 'ready' };
    for (let attempt = 0; attempt < launchPollAttempts; attempt += 1) {
      // force a fresh read each poll so the reported id/title/attention (and a vanished pane)
      // reflect this instant, not the ~2s background snapshot — mirrors the prompt service
      const target = await discovery.target(agent.id, true);
      // a pane that vanished before it settled is a launch that did not survive
      if (target === undefined) return { state: 'blocked', reason: 'the agent closed before it was ready' };
      const capture = await tmux.capture(target.socket, target.agent.paneId).catch(() => undefined) ?? '';
      const readiness = ready(runSnapshot(target.agent), capture);
      // ready to paste, or blocked on something only the operator can clear
      if (readiness.state === 'ready') return { state: 'ready' };
      if (readiness.state === 'blocked') return { state: 'blocked', reason: readiness.reason };
      // pause before retrying
      if (attempt + 1 < launchPollAttempts) await launchPollDelay();
    }
    return { state: 'timed-out' };
  };
  // ── The Run primitive (Scheduled prompts) ─────────────────────────────────────────
  // One server operation performs every Run — Run now on a Schedule, Launch and run on an idle
  // worktree tab, and (later) the scheduler tick. It reuses the Schedule's own idle pane by
  // resetting the conversation through the Adapter's new-conversation command, and launches a
  // fresh agent otherwise; the Note's text is then submitted through the normal prompt path. The
  // caller owns recording `lastRun` and mapping the outcome to HTTP — this returns what happened.
  type RunFailureReason = 'launch-refused' | 'no-agent' | 'not-ready-blocked' | 'not-ready-timeout' | 'delivery-failed' | 'reset-lost';
  type RunOutcome =
    | { status: 'launched'; agentId: string }
    | { status: 'skipped'; detail: string; agentId?: string }
    | { status: 'failed'; detail: string; reason: RunFailureReason; agentId?: string };
  // A reset settles within ~2 s (Claude) / ~1.5 s (Codex); poll a little past that so the
  // Adapter's own budget, not this cap, ends the wait. The injectable poll delay paces it in tests.
  const resetSettleAttempts = 20;
  // how to launch, match and reuse each Schedule target, mirroring the launcher rows; undefined
  // when the target no longer resolves (a removed Worktree, an unavailable directory Project)
  type RunPlan = { matches: (workspace: string) => boolean; launch: () => Promise<boolean>; waitForNewAgent: (before: Set<string>) => Promise<Agent | undefined> };
  const resolveRunPlan = (target: ScheduleTarget, kind: AgentKind | undefined): RunPlan | undefined => {
    if ('worktreeId' in target) {
      const worktree = configuredWorktree(target.worktreeId);
      if (worktree === undefined) return undefined;
      return {
        matches: workspace => worktreeMatchesWorkspace(worktree, workspace),
        launch: async () => { const ok = await launch.launch(target.worktreeId, kind); if (ok) sleepingWorktrees.delete(target.worktreeId); return ok; },
        waitForNewAgent: before => waitForAgent(before, target.worktreeId),
      };
    }
    if ('projectId' in target) {
      const project = config.projects.find(candidate => candidate.id === target.projectId);
      // only an available directory Project launches in place (a repository Project runs through its Worktrees)
      if (project === undefined || !project.available || project.mode !== 'directory') return undefined;
      return {
        // a bridged Project launches at its host path but is discovered at its console path, so match either
        matches: workspace => workspace === project.path || (project.hostPath !== undefined && workspace === project.hostPath),
        launch: () => launch.launchProjectDirectory(target.projectId, kind),
        waitForNewAgent: before => waitForAgent(before, undefined, project.label),
      };
    }
    const directory = config.scratchDirectory ?? launchHome;
    return {
      matches: workspace => workspace === directory,
      launch: () => launch.launchHome(kind),
      waitForNewAgent: before => waitForAgent(before),
    };
  };
  // reuse the Schedule's own idle pane: reset the conversation, wait for the Adapter's settle
  // rule, then submit the Note's text with the reset instant so Codex completion anchors on the
  // fresh thread. Attention working/question and a non-empty composer are skipped, not forced.
  const runReuse = async (prior: { agent: Agent; socket: SocketRef }, capability: NonNullable<Adapter['newConversation']>, text: string): Promise<RunOutcome> => {
    const agentId = prior.agent.id;
    const attention = agentAttentionState(prior.agent);
    if (attention === 'working') return { status: 'skipped', detail: 'previous run still working', agentId };
    if (attention === 'question') return { status: 'skipped', detail: 'previous run is asking a question', agentId };
    // a draft or an open dialog in the composer would merge the reset into a prompt: skip instead.
    // A pane we cannot read is skipped too rather than pasted into blind.
    const capture = await tmux.capture(prior.socket, prior.agent.paneId).catch(() => undefined);
    if (capture === undefined) return { status: 'skipped', detail: 'could not read the pane', agentId };
    if (!capability.composerEmpty(capture)) return { status: 'skipped', detail: 'composer has unsent text', agentId };
    const before = runSnapshot(prior.agent);
    const resetAt = Date.now();
    // paste the reset command through the normal submission path
    if (!await prompts.submitReset(agentId, capability.command)) return { status: 'failed', detail: 'reset did not settle', reason: 'reset-lost', agentId };
    const observed: PaneSnapshot[] = [];
    const start = Date.now();
    let settling: ResetSettling = 'pending';
    for (let attempt = 0; attempt < resetSettleAttempts; attempt += 1) {
      await launchPollDelay();
      const current = await discovery.target(agentId, true);
      // a pane that vanished under the reset is a lost reset
      if (current === undefined) { settling = 'lost'; break; }
      observed.push(runSnapshot(current.agent));
      settling = capability.settled(before, observed, Date.now() - start);
      if (settling !== 'pending') break;
    }
    // a lost or never-settled reset leaves the pane alone (it is the Schedule's own)
    if (settling !== 'settled') return { status: 'failed', detail: 'reset did not settle', reason: 'reset-lost', agentId };
    // submit the note through the prompt service exactly as a typed prompt, carrying the reset instant
    if (!await prompts.submit(agentId, text, [], resetAt)) return { status: 'failed', detail: 'the note could not be delivered', reason: 'delivery-failed', agentId };
    return { status: 'launched', agentId };
  };
  // launch a fresh agent for the target, wait for it and its readiness, then submit the note; a
  // blocked or slow readiness closes the pane this Run created rather than leaving it behind
  const notReadyDetail = `agent did not become ready in ${launchReadyTimeoutSeconds} s`;
  const runFresh = async (plan: RunPlan, text: string): Promise<RunOutcome> => {
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // a refused launch (an unconfigured or unlaunchable kind, or a busy worktree) pastes nothing
    if (!await plan.launch()) return { status: 'failed', detail: 'launch refused', reason: 'launch-refused' };
    const agent = await plan.waitForNewAgent(before);
    if (agent === undefined) return { status: 'failed', detail: notReadyDetail, reason: 'no-agent' };
    const readiness = await waitForReadiness(agent);
    if (readiness.state !== 'ready') {
      // the pane is closed here, so the Run has no pane to remember or deep-link to: drop its id, so
      // lastRun records no agentId and the notification falls back to the Worktree (or root) url
      await prompts.close(agent.id).catch(() => undefined);
      return readiness.state === 'blocked'
        ? { status: 'failed', detail: readiness.reason, reason: 'not-ready-blocked' }
        : { status: 'failed', detail: notReadyDetail, reason: 'not-ready-timeout' };
    }
    if (!await prompts.submit(agent.id, text)) return { status: 'failed', detail: 'the note could not be delivered', reason: 'delivery-failed', agentId: agent.id };
    return { status: 'launched', agentId: agent.id };
  };
  const runOnce = async (input: { text: string; kind: AgentKind | undefined; target: ScheduleTarget; previousAgentId?: string }): Promise<RunOutcome> => {
    // preconditions — a failure records `skipped` with the reason and pastes nothing
    if (!input.text.trim()) return { status: 'skipped', detail: 'note is empty' };
    const plan = resolveRunPlan(input.target, input.kind);
    if (plan === undefined) return { status: 'skipped', detail: 'target is gone' };
    // whether the kind can launch is checked at Run time, since configuration can change
    if (input.kind !== undefined && !launch.isLaunchableKind(input.kind)) return { status: 'skipped', detail: `${input.kind} is not available` };
    // reuse the Schedule's own pane when the remembered agent is still a live agent of the same
    // kind whose workspace is the target; a kind without a reset capability launches fresh
    const capability = input.kind === undefined ? undefined : adapterFor(input.kind)?.newConversation;
    if (input.previousAgentId !== undefined && capability !== undefined) {
      const prior = await discovery.target(input.previousAgentId, true);
      // a live previous agent of another kind or workspace was retargeted: leave it alone, launch fresh
      if (prior !== undefined && prior.agent.kind === input.kind && plan.matches(prior.agent.workspace)) return await runReuse(prior, capability, input.text);
    }
    return await runFresh(plan, input.text);
  };
  const performRun = async (input: { text: string; kind: AgentKind | undefined; target: ScheduleTarget; previousAgentId?: string }): Promise<RunOutcome> => {
    const outcome = await runOnce(input);
    // every outcome refreshes the dashboard, even a precondition skip that changed nothing
    await dashboardUpdates.refresh().catch(() => undefined);
    return outcome;
  };
  // map a non-launched Run outcome to the launch routes' HTTP contract, so Launch and run keeps
  // its 409 / 504 / 502 responses now that it runs through the shared primitive
  const runFailureReply = (outcome: Extract<RunOutcome, { status: 'failed' | 'skipped' }>): { code: number; error: string } => {
    if (outcome.status === 'skipped') return { code: 409, error: outcome.detail };
    switch (outcome.reason) {
      case 'launch-refused': return { code: 409, error: 'Could not start the worktree agent.' };
      case 'no-agent': return { code: 504, error: `The worktree session started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      case 'not-ready-blocked': return { code: 409, error: `The agent started but is not ready: ${outcome.detail}.` };
      case 'not-ready-timeout': return { code: 504, error: `The agent started but did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      case 'delivery-failed': return { code: 502, error: 'The agent started but the note could not be delivered.' };
      // Launch and run never reuses a pane (no previous agent), so a lost reset cannot reach here;
      // the case is kept only to keep the switch exhaustive over RunFailureReason.
      case 'reset-lost': return { code: 409, error: 'The previous run could not be reset.' };
    }
  };
  // Run one Note's Schedule once at the due (or Run-now) instant `at`, and record the outcome on
  // its `lastRun`. One Run per Schedule at a time — the flight guard is shared by Run now and (later)
  // the scheduler tick, so a scheduled tick and a manual Run cannot reset the one pane at once. An
  // unexpected error from a dependency still records a `failed` run, so "every run is recorded" holds
  // even for infrastructure failures. Returns the updated Note, or why nothing ran (Scheduled prompts).
  const scheduleRunsInFlight = new Set<string>();
  const recordedScheduleRun = async (saveKey: string, noteId: string, at: string): Promise<{ note: WorktreeNote } | 'in-flight' | 'gone'> => {
    const note = (await notes.list(saveKey))?.find(candidate => candidate.id === noteId);
    // gone: an unknown Note or a Note without a Schedule to run
    if (note === undefined || note.schedule === undefined) return 'gone';
    const flightKey = `${saveKey}:${noteId}`;
    if (scheduleRunsInFlight.has(flightKey)) return 'in-flight';
    scheduleRunsInFlight.add(flightKey);
    try {
      const schedule = note.schedule;
      let lastRun: ScheduleLastRun;
      try {
        const outcome = await performRun({ text: note.text, kind: schedule.kind, target: schedule.target, ...(schedule.lastRun?.agentId === undefined ? {} : { previousAgentId: schedule.lastRun.agentId }) });
        lastRun = { at, status: outcome.status, ...(outcome.status === 'launched' ? {} : { detail: outcome.detail }), ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }) };
      } catch (error) {
        // an unexpected dependency failure is still an outcome the operator should see, not a lost run
        console.warn(`[schedule] run errored for ${flightKey}:`, error);
        lastRun = { at, status: 'failed', detail: 'run error' };
      }
      const updated = await notes.recordLastRun(saveKey, noteId, lastRun);
      // the Schedule may have been removed mid-run; the outcome is then dropped, notification and all
      if (updated === undefined) return 'gone';
      // a skipped or failed Run notifies so an unattended failure reaches the phone; a launched Run
      // stays quiet (the agent's own "done working" notification already fires when the answer lands)
      if (lastRun.status !== 'launched') {
        const target = resolveScheduleTarget(schedule.target);
        void push.notify(scheduleNotification({
          status: lastRun.status,
          targetLabel: target.label,
          noteId,
          ...(note.title === undefined ? {} : { noteTitle: note.title }),
          ...(lastRun.detail === undefined ? {} : { detail: lastRun.detail }),
          ...(lastRun.agentId === undefined ? {} : { agentId: lastRun.agentId }),
          ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId })
        })).catch(() => undefined);
      }
      return { note: updated };
    } finally {
      scheduleRunsInFlight.delete(flightKey);
    }
  };
  // fire enabled Schedules once a minute, unattended, through the very seam Run now uses. Constructed
  // here so it closes over the real Run primitive; decorated onto the app below so index.ts starts it
  // and the HTTP-seam tests drive its `tick(now)`. It is not started here — tests build the app
  // without a live timer running.
  const scheduler = new Scheduler(() => notes.scheduled(), recordedScheduleRun, scheduleBootAt);
  // Run now on a Schedule: run it synchronously exactly as the scheduler will and return the decorated
  // Note; a second Run now while one is in flight is refused with a conflict.
  const runScheduleNow = async (saveKey: string, noteId: string, reply: FastifyReply): Promise<unknown> => {
    const result = await recordedScheduleRun(saveKey, noteId, new Date().toISOString());
    if (result === 'gone') return reply.code(404).send({ error: 'schedule unavailable' });
    if (result === 'in-flight') return reply.code(409).send({ error: 'A run of this schedule is already in progress.' });
    return decorateNote(result.note);
  };
  // launch and pre-prompt one dedicated update advisor
  const launchUpdateAdvisor = async (targetSha: string): Promise<string | undefined> => {
    const preview = await serverAdmin.updatePreview();
    // require the exact current advisory range
    if (preview === undefined || preview.targetSha !== targetSha) return undefined;
    const advisor = serverAdmin.updateAdvisor(preview);
    // require a server-owned advisor request
    if (advisor === undefined) return undefined;
    const dashboard = await discovery.dashboard();
    const activeTarget = await serverAdmin.activeUpdateTarget();
    const protectedLabels = new Set([updateAdvisorLabel(targetSha), ...(activeTarget === undefined ? [] : [updateAdvisorLabel(activeTarget)])]);
    const protectedIds = new Set<string>();
    // retain only the newest pane for each protected target
    for (const label of protectedLabels) {
      const candidates = dashboard.agents.filter(candidate => candidate.displayLabel === label);
      const newest = candidates.sort((left, right) => Number(right.paneId.slice(1)) - Number(left.paneId.slice(1)))[0];
      // preserve one current advisor
      if (newest !== undefined) protectedIds.add(newest.id);
    }
    const prunedIds = new Set<string>();
    // close mapped advisors superseded by the current target
    for (const [candidateTarget, candidateId] of updateAdvisors) {
      // preserve the requested and actively updating targets
      if (candidateTarget === targetSha || candidateTarget === activeTarget) continue;
      const closed = await prompts.close(candidateId).catch(() => false);
      // forget only panes confirmed closed
      if (closed) {
        updateAdvisors.delete(candidateTarget);
        prunedIds.add(candidateId);
      }
    }
    // recover and prune superseded advisor panes after server restarts
    for (const candidate of dashboard.agents) {
      // retain ordinary agents and one pane for each protected target
      if (!isUpdateAdvisorLabel(candidate.displayLabel) || protectedIds.has(candidate.id) || prunedIds.has(candidate.id)) continue;
      const closed = await prompts.close(candidate.id).catch(() => false);
      // remove recovered mappings only after confirmed cleanup
      if (closed) {
        prunedIds.add(candidate.id);
        for (const [candidateTarget, candidateId] of updateAdvisors) if (candidateId === candidate.id) updateAdvisors.delete(candidateTarget);
      }
    }
    const currentLabel = updateAdvisorLabel(targetSha);
    const existingId = [...protectedIds].find(candidateId => dashboard.agents.some(candidate => candidate.id === candidateId && candidate.displayLabel === currentLabel));
    // reuse one surviving advisor for the reviewed target
    if (existingId !== undefined && await discovery.target(existingId) !== undefined) {
      updateAdvisors.set(targetSha, existingId);
      return existingId;
    }
    const before = new Set(dashboard.agents.map(agent => agent.id));
    // launch inside the fixed host checkout
    if (!await launch.launchUpdateAdvisor(advisor.repository, targetSha)) return undefined;
    const agent = await waitForAgent(before, undefined, updateAdvisorPendingLabel(targetSha));
    // stop after a failed discovery handoff
    if (agent === undefined) return undefined;
    // close an unprompted scratch pane
    if (!await prompts.submitUpdateAdvisor(agent.id, targetSha, advisor.prompt)) {
      await prompts.close(agent.id).catch(() => false);
      return undefined;
    }
    // trust recovered panes only after the initial prompt is scheduled
    if (!await prompts.markUpdateAdvisorReady(agent.id, targetSha)) {
      await prompts.close(agent.id).catch(() => false);
      return undefined;
    }
    updateAdvisors.set(targetSha, agent.id);
    return agent.id;
  };
  // start or reuse a fixed update advisor
  app.post('/api/server/update-advisor', async (request, reply) => {
    controlled(request, true);
    const targetSha = body(request).targetSha;
    // require one reviewed target
    if (!isFullGitSha(targetSha)) return reply.code(400).send({ error: 'Invalid update advisor target.' });
    const agentId = await withUpdateAdvisorLifecycle(targetSha, async () => await launchUpdateAdvisor(targetSha));
    return agentId === undefined ? reply.code(503).send({ error: 'Unable to start the update advisor.' }) : reply.code(201).send({ agentId, targetSha });
  });
  // stop the advisor when its owning update modal closes
  app.delete('/api/server/update-advisor', async (request, reply) => {
    controlled(request, true);
    const targetSha = body(request).targetSha;
    // require one reviewed target
    if (!isFullGitSha(targetSha)) return reply.code(400).send({ error: 'Invalid update advisor target.' });
    const result = await withUpdateAdvisorLifecycle(targetSha, async () => {
      // preserve advice throughout an active host update
      if (await serverAdmin.activeUpdateTarget() === targetSha) return 'active' as const;
      return await stopUpdateAdvisors(targetSha) ? 'stopped' as const : 'failed' as const;
    });
    if (result === 'active') return reply.code(409).send({ error: 'The update advisor is retained while its host update is active.' });
    return result === 'stopped' ? reply.code(204).send() : reply.code(503).send({ error: 'Unable to stop the update advisor.' });
  });
  type IdleRestartResult = { status: 'restarted'; worktreeId: string; agentId: string } | { status: 'skipped'|'failed'; worktreeId: string; reason: 'unavailable'|'not-idle'|'launch-failed'|'timed-out'; error: string };
  // restart one still-idle configured agent
  const restartIdleConfiguredAgent = async (id: string, expectedWorktreeId?: string, expectedMutationVersion?: number, expectedMutationGeneration?: number, threadId?: string, kind?: AgentKind): Promise<IdleRestartResult> => {
    const releaseRestart = await prompts.acquireRestartLock(id, expectedMutationVersion, expectedMutationGeneration);
    // reject overlapping prompt and lifecycle work
    if (releaseRestart === undefined) return { status: 'skipped', worktreeId: expectedWorktreeId ?? 'unknown', reason: 'not-idle', error: 'The worktree is no longer idle.' };
    try {
      const current = await discovery.dashboard(true);
      const observed = current.agents.find(agent => agent.id === id);
      const worktree = observed === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), observed.workspace);
      const worktreeId = worktree?.id ?? expectedWorktreeId ?? 'unknown';
      // require the original configured target
      if (observed === undefined || worktree === undefined || (expectedWorktreeId !== undefined && worktree.id !== expectedWorktreeId)) return { status: 'skipped', worktreeId, reason: 'unavailable', error: 'The worktree agent is no longer open.' };
      // reject working and question states
      if (agentAttentionState(observed) !== 'finished') return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'Only idle configured agents can restart.' };
      // revalidate state before closing
      if (observed.worktreeId !== worktree.id) return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'The worktree agent is no longer idle.' };
      const queued = await queuedPrompts.list(promptStorageKeyForAgent(observed)).then(prompts => prompts?.length).catch(() => undefined);
      // preserve queued or unreadable prompt work
      if (queued === undefined || queued > 0) return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'The worktree has queued prompts.' };
      // validate exact resume before closing the current agent
      if (threadId !== undefined && !launch.canResumeConversation(worktree.id)) return { status: 'failed', worktreeId, reason: 'launch-failed', error: 'Exact chat resume is not configured for this worktree.' };
      const before = new Set(current.agents.map(agent => agent.id));
      // require the original agent to close
      if (!await prompts.close(id)) return { status: 'skipped', worktreeId, reason: 'unavailable', error: 'The worktree agent could not be closed.' };
      sleepingWorktrees.add(worktree.id);
      const resumed = threadId === undefined ? await launch.resume(worktree.id, kind) : await launch.resumeConversation(worktree.id, threadId, kind);
      // require the resumed agent to start
      if (!resumed) {
        await dashboardUpdates.refresh().catch(() => undefined);
        return { status: 'failed', worktreeId, reason: 'launch-failed', error: 'The agent closed, but it could not be resumed.' };
      }
      const agent = await waitForAgent(before, worktree.id);
      // retain recovery controls after a timeout
      if (agent === undefined) {
        await dashboardUpdates.refresh().catch(() => undefined);
        return { status: 'failed', worktreeId, reason: 'timed-out', error: `The agent closed and resumed, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      }
      sleepingWorktrees.delete(worktree.id);
      await dashboardUpdates.refresh().catch(() => undefined);
      return { status: 'restarted', worktreeId, agentId: agent.id };
    } finally {
      releaseRestart();
    }
  };
  // query all configured Codex accounts on menu open
  app.get('/api/codex/accounts', async (request, reply) => {
    controlled(request);
    try {
      return { accounts: (await accounts.listAccounts()).map(publicAccount) };
    } catch {
      return reply.code(503).send({ error: 'Unable to load ChatGPT accounts.' });
    }
  });
  // switch the global account and restart every open idle worktree
  app.post('/api/codex/accounts/switch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = body(request).id;
    // require one bounded configured identifier
    if (typeof id !== 'string' || !safeAccountId.test(id)) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    // serialize switch and restart handoffs
    if (accountSwitching) return reply.code(409).send({ error: 'Another ChatGPT account switch is already running.' });
    accountSwitching = true;
    try {
      const selectionMutationGeneration = prompts.mutationGeneration();
      const discovered = await discovery.dashboard();
      const queuedCounts = await queuedPromptCounts(discovered.agents);
      const byWorktree = new Map<string, Agent[]>();
      // group only open configured worktrees
      for (const agent of discovered.agents) {
        // ignore scratch and stale configured identifiers
        if (agent.worktreeId === undefined || discovery.worktreesNow().every(worktree => worktree.id !== agent.worktreeId)) continue;
        const group = byWorktree.get(agent.worktreeId) ?? [];
        group.push(agent);
        byWorktree.set(agent.worktreeId, group);
      }
      const restartTargets: Array<{ agentId: string; worktreeId: string; mutationVersion: number; mutationGeneration: number }> = [];
      const skipped: Array<{ worktreeId: string; status: 'skipped'; error: string }> = [];
      // select only unambiguous idle worktrees
      for (const [worktreeId, agents] of byWorktree) {
        const agent = agents[0];
        // preserve duplicate, active, questioning, and queued work
        if (agent === undefined || agents.length !== 1 || agentAttentionState(agent) !== 'finished' || (queuedCounts.get(agent.id) ?? 1) > 0) {
          skipped.push({ worktreeId, status: 'skipped', error: 'The worktree is not idle.' });
          continue;
        }
        restartTargets.push({ agentId: agent.id, worktreeId, mutationVersion: prompts.mutationVersion(agent.id), mutationGeneration: selectionMutationGeneration });
      }
      const account = await accounts.switchAccount(id);
      const restarted = await Promise.all(restartTargets.map(async target => {
        try {
          const result = await restartIdleConfiguredAgent(target.agentId, target.worktreeId, target.mutationVersion, target.mutationGeneration);
          // expose only the stable worktree outcome
          return result.status === 'restarted'
            ? { worktreeId: result.worktreeId, status: 'restarted' as const }
            : { worktreeId: result.worktreeId, status: result.status, error: result.error };
        } catch {
          return { worktreeId: target.worktreeId, status: 'failed' as const, error: 'The worktree could not be restarted.' };
        }
      }));
      return { account: publicAccount(account), restarts: [...restarted, ...skipped] };
    } catch {
      return reply.code(404).send({ error: 'Unable to switch ChatGPT accounts.' });
    } finally {
      accountSwitching = false;
    }
  });
  // redeem one reset credit for a configured ChatGPT account
  app.post('/api/codex/accounts/:id/reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    // require one bounded configured identifier
    if (!safeAccountId.test(id)) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    try {
      const result = await accounts.consumeRateLimitReset(id);
      return { outcome: result.outcome, ...(result.account === undefined ? {} : { account: publicAccount(result.account) }) };
    } catch (error) {
      // distinguish missing slots from provider failures
      if (error instanceof Error && error.message === 'Account not found') return reply.code(404).send({ error: 'ChatGPT account not found.' });
      return reply.code(502).send({ error: 'Unable to use the ChatGPT reset.' });
    }
  });
  // start one isolated ChatGPT device-code login
  app.post('/api/codex/accounts/login', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    controlled(request, true);
    const repairAccountId = body(request).repairAccountId;
    // validate optional repair targets
    if (repairAccountId !== undefined && (typeof repairAccountId !== 'string' || !safeAccountId.test(repairAccountId))) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    try {
      return reply.code(201).send({ login: await accounts.startAddAccount(repairAccountId) });
    } catch (error) {
      // distinguish missing repair targets
      if (error instanceof Error && error.message === 'Account not found') return reply.code(404).send({ error: 'ChatGPT account not found.' });
      return reply.code(503).send({ error: 'Unable to start ChatGPT login.' });
    }
  });
  // report one device-code login state
  app.get('/api/codex/accounts/login/:id', async (request) => {
    controlled(request);
    const status = await accounts.status((request.params as { id: string }).id);
    // flatten newly configured accounts
    return status.status === 'succeeded' ? { ...status, account: publicAccount(status.account) } : status;
  });
  // cancel one abandoned device-code login
  app.delete('/api/codex/accounts/login/:id', async (request, reply) => {
    controlled(request, true);
    return await accounts.cancelAddAccount((request.params as { id: string }).id) ? reply.code(204).send() : reply.code(404).send({ error: 'ChatGPT login unavailable.' });
  });
  // resume a listed Conversation in its home Worktree. `:id` is the Conversation's home
  // Worktree; the body's `{ kind, id }` is one row of that Project's conversations list. A
  // shared codex-family rollout resumes under the Worktree's remembered Launch kind (ADR
  // 0005 relaxed), and the id is resolved and validated through that kind's own Adapter.
  app.post('/api/worktrees/:id/conversations/switch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const { kind, id: conversationId } = body(request) as { kind?: unknown; id?: unknown };
    const worktree = configuredWorktree(id);
    // require one configured worktree
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // reject a malformed switch target
    if (typeof conversationId !== 'string' || typeof kind !== 'string' || !agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const rowKind = kind as AgentKind;
    // a shared codex-family row follows the Worktree's remembered Launch kind (codex or omx),
    // else Codex; every other kind resumes as itself
    const resumeKind = codexFamily(rowKind) ? await rememberedCodexKind(worktree.id) : rowKind;
    // resume through the row's own Adapter (validId replaces the launch service's UUID check)
    if (adapterFor(resumeKind)?.conversations?.validId(conversationId) !== true) return reply.code(409).send({ error: 'This conversation cannot be resumed.' });
    // the resolved kind must itself be launchable, so a de-configured kind (e.g. a Worktree
    // that last ran OMX after OMX was removed) fails here rather than after the restart path
    // has already closed the live agent
    if (launch.isLaunchableKind?.(resumeKind) === false) return reply.code(409).send({ error: 'This conversation cannot be resumed.' });
    // require the Conversation to be homed in this Worktree: a scan of only this Worktree's
    // directory lists it exactly when the agent's own picker would resume it here
    const homeDirectory = worktreeHostRoot(worktree);
    const homed = (await discovery.conversations([homeDirectory])).some(row => sameConversation(row, { kind: rowKind, id: conversationId }));
    if (!homed) return reply.code(409).send({ error: 'This conversation does not belong to this worktree.' });
    // fail before any destructive handoff
    if (!launch.canResumeConversation(worktree.id)) return reply.code(409).send({ error: 'Exact chat resume is not configured for this worktree.' });
    const selectionMutationGeneration = prompts.mutationGeneration();
    const current = await discovery.dashboard(true);
    const open = current.agents.filter(agent => agent.worktreeId === worktree.id);
    // avoid an ambiguous destructive handoff
    if (open.length > 1) return reply.code(409).send({ error: 'Close duplicate worktree agents before switching chats.' });
    const activeAgent = open[0];
    // restart one existing idle agent safely, resuming through the row's own Adapter
    if (activeAgent !== undefined) {
      const result = await restartIdleConfiguredAgent(activeAgent.id, worktree.id, prompts.mutationVersion(activeAgent.id), selectionMutationGeneration, conversationId, resumeKind);
      // return one successful replacement
      if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
      // distinguish stale targets from active work
      if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
      return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
    }
    const before = new Set(current.agents.map(agent => agent.id));
    // launch an inactive worktree directly into the Conversation, through its own Adapter
    if (!await launch.resumeConversation(worktree.id, conversationId, resumeKind)) return reply.code(409).send({ error: 'Could not resume the conversation.' });
    const agent = await waitForAgent(before, worktree.id);
    // surface slow or failed resume handoffs
    if (agent === undefined) return reply.code(504).send({ error: `The conversation started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    sleepingWorktrees.delete(worktree.id);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ agentId: agent.id });
  });
  // restart one idle configured agent by resuming its last conversation
  app.post('/api/agents/:id/restart', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const mutationGeneration = prompts.mutationGeneration();
    const result = await restartIdleConfiguredAgent(id, undefined, prompts.mutationVersion(id), mutationGeneration, undefined, kind.kind);
    // return one successful replacement
    if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
    // distinguish missing targets from active work
    if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
    return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
  });
  app.post('/api/worktrees/:id/launch', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // require a successful launch handoff (refuses an unconfigured or unlaunchable kind)
    if (!await launch.launch(worktreeId, kind.kind)) return reply.code(409).send({ error: 'Could not start the worktree agent.' });
    sleepingWorktrees.delete(worktreeId);
    const agent = await waitForAgent(before, worktreeId);
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The worktree session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  // Launch and run one Note on an idle Worktree tab — the fresh-launch entry into the Run
  // primitive (Scheduled prompts). It records nothing on the Note and returns the new agent id
  // so the web can switch to its tab; the primitive keeps the 409 / 504 / 502 contract /launch
  // uses (a blocked or slow readiness closes the pane it created), mapped from the outcome.
  app.post('/api/worktrees/:id/notes/:noteId/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const saveKey = worktreeSaveKey(id);
    if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const note = (await notes.list(saveKey))?.find(candidate => candidate.id === noteId);
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    // never launch an agent for an empty note
    if (!note.text.trim()) return reply.code(400).send({ error: 'note is empty' });
    const outcome = await performRun({ text: note.text, kind: kind.kind, target: { worktreeId: id } });
    if (outcome.status === 'launched') return reply.code(201).send({ agentId: outcome.agentId });
    const failure = runFailureReply(outcome);
    return reply.code(failure.code).send({ error: failure.error });
  });
  // launch an agent in place in a non-git `directory` Project (it has no Worktrees). The
  // new session is labeled with the Project, so it is matched back by display label.
  app.post('/api/projects/:id/launch', async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const project = config.projects.find(candidate => candidate.id === projectId);
    // only an available non-git directory Project launches in place
    if (project === undefined || !project.available || project.mode !== 'directory') return reply.code(404).send({ error: 'project unavailable' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // require a successful launch handoff (refuses an unconfigured or unlaunchable kind)
    if (!await launch.launchProjectDirectory(projectId, kind.kind)) return reply.code(409).send({ error: 'Could not start the project agent.' });
    const agent = await waitForAgent(before, undefined, project.label);
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The project session started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  // the branches the Add dialog offers — local branches (flagged when a Worktree already
  // holds one, which the checkout picker hides but the base picker keeps) plus remote-only
  // branches — and the resolved default branch to pre-select the base
  app.get('/api/projects/:id/branches', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const result = await worktreeManagement.branches((request.params as { id: string }).id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { branches: result.branches, ...(result.defaultBranch === undefined ? {} : { defaultBranch: result.defaultBranch }) };
  });
  // create a Worktree for a new or existing branch, pin it, run the Project's configured
  // `commands.setup` to prepare the fresh checkout, give it an idle shell, and — unless the
  // operator opted out — launch the Project's last-used kind in it. The created Worktree
  // stands even when setup or the agent launch fails, so the response is a 201 carrying the
  // new Worktree id plus the started agent, a launch error, and/or a setup error, never a 504.
  app.post('/api/projects/:id/worktrees', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const requestBody = body(request);
    const { mode, branch, base, launch: launchAgent } = requestBody;
    // hand-validate the body before any git runs
    // structural validation only; the service owns branch-name legality (a 409)
    if (mode !== 'new' && mode !== 'existing') return reply.code(400).send({ error: 'invalid worktree mode' });
    if (typeof branch !== 'string' || branch.length === 0) return reply.code(400).send({ error: 'invalid branch name' });
    if (base !== undefined && (typeof base !== 'string' || base.length > 255)) return reply.code(400).send({ error: 'invalid base' });
    if (launchAgent !== undefined && typeof launchAgent !== 'boolean') return reply.code(400).send({ error: 'invalid launch flag' });
    const outcome = await worktreeManagement.add(projectId, { mode, branch, ...(typeof base === 'string' ? { base } : {}) });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    // republish discovery so the new checkout is keyed and resolvable before pin and launch
    discovery.invalidateWorktrees();
    const worktree = (await discovery.worktrees(true)).find(candidate => candidate.identity === outcome.path);
    const worktreeId = worktree?.id ?? worktreeWireId(projectId, outcome.path);
    // a created checkout keeps its tab from the start
    await worktreeStore.setPinned(worktreeId, true).catch(() => {});
    // Prepare the fresh checkout, then give it its idle shell so it has a tab even without an
    // agent; then, unless the operator opted out, launch the Project's last-used kind — the
    // launch path adopts that idle shell once it is up, else starts the agent's own session.
    // Setup runs once here (a no-op when unconfigured) and blocks until it finishes; a setup
    // failure never fails the creation but does gate the launch, so no agent starts into a
    // half-prepared worktree. The creation stands regardless: any failure past this point is a
    // setupError and/or launchError, never a non-201.
    let agentId: string | undefined;
    let launchError: string | undefined;
    let setupError: string | undefined;
    if (worktree === undefined) {
      launchError = 'The worktree was created, but it could not be resolved to launch an agent.';
    } else {
      const setup = await stackCommands.runSetup(worktree);
      if (!setup.ok) {
        setupError = 'The worktree was created, but its setup command failed.';
        // the operator sees a generic banner; the host log (kept only on failure) carries the output
        if (setup.log !== undefined) console.error(`[worktrees] setup failed for ${worktreeId}; see ${setup.log}`);
      }
      if (launchAgent === false || !setup.ok) {
        // a prepared or opted-out worktree still gets its idle shell, and thus a tab
        if (!await launch.startWorktreeShell(worktree)) launchError = 'The worktree was created, but its shell could not be started.';
      } else {
        await launch.startWorktreeShell(worktree);
        const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
        // report the agent when it appears, but never fail the creation on a slow launch
        if (await launch.launch(worktreeId)) agentId = (await waitForAgent(before, worktreeId))?.id;
        else launchError = 'The worktree was created, but the agent could not be started.';
      }
    }
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ worktreeId, ...(agentId === undefined ? {} : { agentId }), ...(launchError === undefined ? {} : { launchError }), ...(setupError === undefined ? {} : { setupError }) });
  });
  // the runtime blockers that refuse a Remove, named for the 409: a live Agent in the
  // Worktree, or a running stack operation there. `fresh` forces a live pane scan before a
  // destructive removal so an Agent that started within the discovery cache window is never
  // missed (CONTRIBUTING: validate immediately before a destructive operation).
  const worktreeRemovalBlockers = async (worktree: Worktree, fresh = false): Promise<string[]> => {
    const blockers: string[] = [];
    if ((await discovery.dashboard(fresh)).agents.some(agent => agent.worktreeId === worktree.id)) blockers.push('a running agent');
    if (await stackCommands.sessionRunning(worktree)) blockers.push('a running stack command');
    return blockers;
  };
  // delete every record a Worktree leaves behind, keyed by its wire id: the pin and last-used
  // kind, the queued prompts, prompt history and the saved review tour, and the sleeping tab — so
  // a removed (then possibly recreated-at-the-same-path) Worktree leaves no stale trace.
  // Project-scoped notes and console-named conversations are shared and deliberately retained.
  // Shared by Remove (one Worktree) and Prune (each orphaned record).
  const deleteWorktreeRecords = async (worktreeId: string): Promise<void> => {
    sleepingWorktrees.delete(worktreeId);
    await Promise.all([
      worktreeStore.delete(worktreeId).catch(() => {}),
      queuedPrompts.clearScope(worktreeId).catch(() => {}),
      promptHistory.clearScope(worktreeId).catch(() => {}),
      reviewStore.invalidate(worktreeId).catch(() => {})
    ]);
  };
  // after a Prune, delete the console records whose path git now lists nowhere for this
  // Project — the orphaned-record half of the stale set discovery counts (ADR 0003)
  const pruneOrphanRecords = async (projectId: string): Promise<void> => {
    const listed = new Set((await discovery.worktrees(true)).filter(worktree => worktree.projectId === projectId).map(worktree => worktree.path));
    const orphans = (await worktreeStore.keys().catch(() => [] as string[])).filter(key => { if (projectIdOf(key) !== projectId) return false; const path = worktreePathOf(key); return path !== undefined && !listed.has(path); });
    await Promise.all(orphans.map(key => deleteWorktreeRecords(key)));
  };
  // expose fresh deletion facts for one branch in a worktree's repository
  app.get('/api/worktrees/:id/branch-removal', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const branch = (request.query as { branch?: unknown }).branch;
    // validate the branch before repository lookup
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return reply.code(400).send({ error: 'invalid branch name' });
    const worktree = configuredWorktree((request.params as { id: string }).id);
    // require a configured repository context
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const result = await worktreeManagement.branchRemoval(worktree.projectId, branch);
    // surface fresh git refusals
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.facts;
  });
  // delete one local branch behind fresh checkout, remote, and merge guards
  app.delete('/api/worktrees/:id/branch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { branch, discardUnpushed } = body(request);
    // validate every destructive input
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return reply.code(400).send({ error: 'invalid branch name' });
    // restrict the acknowledgement to a boolean
    if (discardUnpushed !== undefined && typeof discardUnpushed !== 'boolean') return reply.code(400).send({ error: 'invalid discardUnpushed flag' });
    const worktree = configuredWorktree((request.params as { id: string }).id);
    // require a configured repository context
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const result = await worktreeManagement.deleteBranchGuarded(worktree.projectId, branch, discardUnpushed === true);
    // preserve the branch on every guard failure
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    await cleanup.scan().catch(() => undefined);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // the fresh facts the Remove dialog decides with, plus the runtime blockers (a GET is a
  // read, so it never mutates and stays off the 10/min mutation budget)
  app.get('/api/worktrees/:id/removal', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const worktree = configuredWorktree((request.params as { id: string }).id);
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const result = await worktreeManagement.removal(worktree);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { ...result.facts, blockers: await worktreeRemovalBlockers(worktree) };
  });
  // remove one linked Worktree: refused on Main, on a locked checkout, while an Agent or a
  // stack session runs there, and on a dirty tree unless discardChanges was ticked. Order:
  // kill the idle shells → git worktree remove → delete records → optional branch delete →
  // invalidate → refresh (ADR 0003). A branch-delete failure is reported, never undone.
  app.delete('/api/worktrees/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const requestBody = body(request);
    const { discardChanges, deleteBranch } = requestBody;
    if (discardChanges !== undefined && typeof discardChanges !== 'boolean') return reply.code(400).send({ error: 'invalid discardChanges flag' });
    if (deleteBranch !== undefined && typeof deleteBranch !== 'boolean') return reply.code(400).send({ error: 'invalid deleteBranch flag' });
    const worktree = configuredWorktree((request.params as { id: string }).id);
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    if (worktree.main) return reply.code(409).send({ error: 'the main worktree cannot be removed' });
    if (worktree.locked) return reply.code(409).send({ error: 'Locked worktrees cannot be removed' });
    const blockers = await worktreeRemovalBlockers(worktree, true);
    if (blockers.length > 0) return reply.code(409).send({ error: `cannot remove the worktree while ${blockers.join(' and ')} ${blockers.length === 1 ? 'is' : 'are'} running` });
    const facts = await worktreeManagement.removal(worktree);
    if (!facts.ok) return reply.code(facts.status).send({ error: facts.error });
    // a dirty tree needs the explicit discard; an unpushed one only warns, never blocks
    if (facts.facts.dirtyCount > 0 && discardChanges !== true) return reply.code(409).send({ error: 'the worktree has uncommitted changes; tick "Discard uncommitted changes" to remove it' });
    await launch.killWorktreeShells(worktree);
    const removed = await worktreeManagement.removeCheckout(worktree, { force: discardChanges === true });
    if (!removed.ok) return reply.code(removed.status).send({ error: removed.error });
    await deleteWorktreeRecords(worktree.id);
    let branchDeleted: boolean | undefined;
    let branchDeleteError: string | undefined;
    // deleting the branch is the operator's explicit decision — the dialog warns first when it
    // is neither pushed nor merged, so a request that still asks for it is honoured
    if (deleteBranch === true && facts.facts.branch !== undefined) {
      const outcome = await worktreeManagement.deleteBranch(worktree, facts.facts.branch);
      if (outcome.ok) branchDeleted = true; else branchDeleteError = outcome.error;
    }
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return { removed: true, ...(branchDeleted === undefined ? {} : { branchDeleted }), ...(branchDeleteError === undefined ? {} : { branchDeleteError }) };
  });
  // clear git's prunable entries and the console's orphaned records for one Project, both
  // explicit and never automatic (ADR 0003)
  app.post('/api/projects/:id/worktrees/prune', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const outcome = await worktreeManagement.prune(projectId);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    await pruneOrphanRecords(projectId);
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // forget one retained sleeping worktree tab
  app.post('/api/worktrees/:id/deactivate', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    // require a configured sleeping worktree
    if (configuredWorktree(worktreeId) === undefined || !sleepingWorktrees.has(worktreeId)) return reply.code(409).send({ error: 'worktree is not sleeping' });
    sleepingWorktrees.delete(worktreeId);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // wake one sleeping worktree by resuming its last conversation
  app.post('/api/worktrees/:id/wake', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    // reject ordinary inactive worktrees
    if (configuredWorktree(worktreeId) === undefined || !sleepingWorktrees.has(worktreeId)) return reply.code(409).send({ error: 'worktree is not sleeping' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // require a successful resume handoff
    if (!await launch.resume(worktreeId, kind.kind)) return reply.code(409).send({ error: 'Could not resume the worktree agent.' });
    const agent = await waitForAgent(before, worktreeId);
    // preserve the sleep screen after a failed resume
    if (!agent) return reply.code(504).send({ error: `The worktree session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    sleepingWorktrees.delete(worktreeId);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ agentId: agent.id });
  });
  app.post('/api/worktrees/:id/commands/:action', async (request, reply) => { controlled(request, true); const action = (request.params as { action: string }).action; if (!(stackActions as readonly string[]).includes(action)) return reply.code(404).send({ error: 'stack command unavailable' }); const result = await stackCommands.start((request.params as { id: string }).id, action as StackAction); if (result === 'busy') return reply.code(409).send({ error: 'stack operation already running' }); return result === false ? reply.code(404).send({ error: 'stack command unavailable' }) : reply.code(202).send(); });
  app.get('/api/worktrees/:id/commands/log', async (request, reply) => {
    controlled(request, false);
    const log = await stackCommands.log((request.params as { id: string }).id);
    // report stacks without retained output separately
    if (log === undefined) return reply.code(404).send({ error: 'stack log unavailable' });
    return log;
  });
  app.post('/api/agents/launch', async (request, reply) => {
    controlled(request, true);
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    if (!await launch.launchHome(kind.kind)) return reply.code(409).send({ error: 'Could not start a new agent session.' });
    const agent = await waitForAgent(before);
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The new session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  app.post('/api/agents/:id/tickets', async (request, reply) => { const s = controlled(request, true); const kind = body(request).kind; if (kind !== 'input' && kind !== 'logs') return reply.code(400).send({ error: 'invalid ticket type' }); const target = await discovery.target((request.params as { id: string }).id); if (!target) return reply.code(404).send({ error: 'target unavailable' }); return { ticket: tickets.mint(s.id, kind as TicketKind, target.agent.id).id }; });
  app.get('/ws/dashboard', { websocket: true }, async (socket, request) => {
    try {
      const s = controlled(request, false);
      const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())[1];
      if (!tickets.consume(ticket, s.id, 'dashboard', 'dashboard')) throw new Error();
      const send = (value: DashboardPayload) => {
        if (!control.active(s.id)) return socket.close(1008);
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'dashboard', dashboard: value }));
      };
      const unsubscribe = dashboardUpdates.subscribe(send);
      const lease = setInterval(() => { if (!control.active(s.id)) socket.close(1008); }, 5_000);
      socket.on('close', () => { clearInterval(lease); unsubscribe(); });
      void dashboardUpdates.refresh().catch(() => {});
    } catch { socket.close(1008); }
  });
  app.get('/ws/logs/:id', { websocket: true }, async (socket, request) => {
    try {
      const s = controlled(request, false);
      const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1];
      const id = (request.params as { id: string }).id;
      if (!tickets.consume(ticket, s.id, 'logs', id)) throw new Error();
      const target = await discovery.target(id);
      if (!target) throw new Error();
      let paneViewport: ReturnType<typeof paneViewports.acquire> | undefined;
      const viewportLease = () => paneViewport ??= paneViewports.acquire(
        `${target.socket.fingerprint}:${target.agent.paneId}`,
        () => tmux.size(target.socket, target.agent.paneId),
        (nextCols, nextRows) => tmux.resize(target.socket, target.agent.paneId, nextCols, nextRows),
        () => tmux.unpinWindowSize(target.socket, target.agent.paneId)
      );
      let last = '';
      let history = 0;
      let rows = 36;
      let cols = 120;
      let lastResetAt = 0;
      let polling = false;
      let pollQueued = false;
      let metadataRefreshAt = Date.now() + logMetadataRefreshMs;
      let viewportEstablished = false;
      let viewportRefreshing = false;
      let viewVersion = 0;
      const poll = async (immediate = false) => {
        if (polling) {
          pollQueued ||= immediate;
          return;
        }
        polling = true;
        const requestedHistory = history;
        const requestedRows = rows;
        const requestedVersion = viewVersion;
        try {
          if (!control.active(s.id)) return socket.close(1008);
          const detailed = requestedHistory > 0 || Date.now() >= metadataRefreshAt;
          const captured = detailed
            ? await tmux.captureWindow(target.socket, target.agent.paneId, requestedHistory, requestedRows)
            : await (tmux.captureRecentWindow?.(target.socket, target.agent.paneId, requestedRows) ?? tmux.captureWindow(target.socket, target.agent.paneId, requestedHistory, requestedRows));
          if (captured === undefined) return socket.close(1008);
          // A page/viewport request may arrive while tmux is capturing the old
          // window. Never publish that stale window: it makes the next click
          // appear to skip a page.
          if (requestedVersion !== viewVersion) {
            pollQueued = true;
            return;
          }
          const frame = requestedHistory === 0 ? logFrame(last, captured.text, detailed) : logFrame('', captured.text);
          // skip unchanged cheap captures
          if (frame === undefined) return;
          const now = Date.now();
          if (!immediate && lastResetAt && now - lastResetAt < 750) return;
          last = captured.text;
          lastResetAt = now;
          if (socket.readyState === socket.OPEN) {
            // parse the viewed agent's capture for an inline numbered choice
            // list — on every frame (a detailed frame's isolated message, else the
            // visible window) so the web renders it promptly rather than parsing
            // pane text itself and without waiting on the periodic detailed frame
            const question = adapterFor(target.agent.kind)?.questions?.parse?.(captured.latestAgentMessage ?? captured.text);
            const metadata = detailed ? { state: 'complete' as const, latestAgentMessage: captured.latestAgentMessage ?? null, latestAssistantMessage: captured.latestAssistantMessage ?? null, latestAssistantMessageOverflows: captured.latestAssistantMessageOverflows === true } : undefined;
            socket.send(JSON.stringify({ v: 1, ...frame, older: captured.older, newer: requestedHistory > 0, ...(metadata === undefined ? {} : { metadata }), ...(question === undefined ? {} : { question }), ...(captured.lastPrompt === undefined ? {} : { lastPrompt: captured.lastPrompt }) }));
            // defer the next successful full-history scan
            if (detailed && requestedHistory === 0) metadataRefreshAt = Date.now() + logMetadataRefreshMs;
          }
        } finally {
          polling = false;
          if (pollQueued) {
            pollQueued = false;
            void poll(true);
          }
        }
      };
      const requestView = (nextHistory: number) => {
        const returningToLive = history > 0 && nextHistory === 0;
        history = nextHistory;
        last = '';
        // refresh metadata after leaving history
        if (returningToLive) metadataRefreshAt = 0;
        viewVersion += 1;
        void poll(true);
      };
      const viewport = new LatestViewportScheduler(
        (nextCols, nextRows) => viewportLease().resize(nextCols, nextRows),
        requestView
      );
      const refresh = async () => {
        if (viewportRefreshing) return;
        viewportRefreshing = true;
        try {
          if (viewportEstablished) {
            // each tick re-targets the pane: external layout changes are
            // repaired, and a terminal attached to the session caps the size
            const ensured = await viewportLease().ensure(cols, rows);
            if (!ensured.ok) return socket.close(1011);
            if (ensured.resized) {
              requestView(history);
              return;
            }
          }
          if (history === 0) await poll();
        } finally {
          viewportRefreshing = false;
        }
      };
      const timer = setInterval(() => { void refresh(); }, config.pollIntervalMs);
      socket.on('message', (raw: unknown) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame?.v !== 1 || typeof frame?.type !== 'string') throw new Error();
          if (frame.type === 'viewport') {
            const requested = boundedViewport(frame);
            if (requested === undefined) throw new Error();
            ({ cols, rows } = requested);
            viewportEstablished = true;
            void viewport.schedule({ cols, rows, history, onFailure: () => socket.close(1011) });
            return;
          }
          if (frame.type === 'history') {
            if (!Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > 5_000) throw new Error();
            const hasViewport = frame.cols !== undefined || frame.rows !== undefined;
            if (!hasViewport) { requestView(frame.offset); return; }
            const requested = boundedViewport(frame);
            if (requested === undefined) throw new Error();
            ({ cols, rows } = requested);
            viewportEstablished = true;
            void viewport.schedule({ cols, rows, history: frame.offset, onFailure: () => socket.close(1011) });
            return;
          }
          if (frame.type === 'metadata') {
            // refresh only the live pane
            if (history !== 0) throw new Error();
            metadataRefreshAt = 0;
            void poll(true);
            return;
          }
          throw new Error();
        } catch { socket.close(1008); }
      });
      socket.on('close', () => { clearInterval(timer); if (paneViewport !== undefined) void paneViewport.release(); });
      await poll();
    } catch { socket.close(1008); }
  });
  app.get('/ws/input/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const id = (request.params as { id: string }).id; if (!tickets.consume(ticket, s.id, 'input', id)) throw new Error(); const target = await discovery.target(id); if (!target) throw new Error(); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || frame?.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (!decoded.length || decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); const input = decoded.toString('utf8'); const releaseMutation = prompts.beginAgentMutation(id); if (releaseMutation === undefined) throw new Error(); /* route interrupts through queue cancellation; forward the literal Ctrl+C when the agent is idle so a live-log interrupt still reaches the pane */ void (input === '\x03' ? prompts.cancel(id).then(outcome => outcome === 'not-working' ? tmux.input(target.socket, target.agent.paneId, input) : outcome === 'ok') : tmux.input(target.socket, target.agent.paneId, input)).then(ok => { if (!ok) socket.close(1011); }).finally(releaseMutation); } catch { socket.close(1008); } }); } catch { socket.close(1008); } });
  app.addHook('onClose', async () => { scheduler.stop(); reviewJobs.close(); await accounts.close(); await paneViewports.restoreAll(); dashboardUpdates.close(); });
  // expose the scheduler on the instance (index.ts starts it; the HTTP-seam tests tick it)
  app.decorate('scheduler', scheduler);
  return app;
}
