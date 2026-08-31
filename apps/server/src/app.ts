import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ValidatedConfig } from './config/schema.js';
import { AuthService, type Session } from './auth/service.js';
import { ControlService } from './auth/control.js';
import { DeviceService } from './auth/devices.js';
import { TicketStore, type TicketKind } from './auth/tickets.js';
import { DiscoveryService } from './discovery/service.js';
import { adapterFor } from './adapters/registry.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { maxPromptAttachments, maxPromptAttachmentBytes, PromptService, type PromptAttachment } from './prompts/service.js';
import { validPrompt } from './prompts/validation.js';
import { QueuedPromptService } from './prompts/queue.js';
import { LaunchService } from './launch/service.js';
import * as pty from 'node-pty';
import { safeEnv } from './tmux/command.js';
import { PushService } from './push-service.js';
import { WorktreeCommandService } from './worktree-commands/service.js';
import { PullRequestSwitchService } from './pull-requests/switch-service.js';
import { NewTaskService } from './new-task/service.js';
import { SavedPromptService } from './saved-prompts/service.js';
import { agentAttentionState, AgentNotificationCoordinator } from './notifications.js';
import { stackActions, type Agent, type StackAction } from './domain/models.js';
import { CommandCatalogService } from './commands/service.js';
import { LatestViewportScheduler, PaneViewportCoordinator } from './logs/viewport-scheduler.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { WorktreeNoteService } from './notes/service.js';
import { CleanupService } from './cleanup/service.js';
import { PromptHistoryService } from './prompt-history/service.js';
import { ProjectProxy } from './project-proxy.js';
import { CodexExecReviewTourGenerator } from './review-tour/generator.js';
import { ReviewTourService } from './review-tour/service.js';
import { ReviewTourJobs } from './review-tour/jobs.js';
import { ReviewTourStore } from './review-tour/store.js';
import { parseReviewRequestId, parseReviewTourInput, REVIEW_REQUEST_BODY_BYTES, ReviewTourError, type ReviewErrorCode, type ReviewTourInput } from './review-tour/contracts.js';
import { configuredWorktreeForWorkspace, worktreeMatchesWorkspace } from './workspaces/resolver.js';
import { WorkspaceFileService } from './workspace-files/service.js';
import { instanceIconSvg, isInstanceIcon } from './instance-icon.js';
import { instanceAttention, RemoteInstanceStatusPoller, validInstanceStatusRequest, type InstanceStatus } from './instance-status.js';
import { createHash, createHmac } from 'node:crypto';
import { defaultIntegrationConfig } from './config/schema.js';
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
import { BookmarkService } from './bookmarks/service.js';
import { isUpdateAdvisorForTarget, isUpdateAdvisorLabel, updateAdvisorLabel, updateAdvisorPendingLabel } from './update-advisor.js';
import { isFullGitSha } from './git/revision.js';

export type Dependencies = { auth?: AuthService; control?: ControlService; devices?: DeviceService; discovery?: DiscoveryService; tmux?: TmuxAdapter; tickets?: TicketStore; launch?: LaunchService; launchPollDelay?: () => Promise<void>; push?: PushService; notifications?: AgentNotificationCoordinator; prSwitch?: PullRequestSwitchService; newTask?: NewTaskService; savedPrompts?: SavedPromptService; promptHistory?: PromptHistoryService; queuedPrompts?: QueuedPromptService; notes?: WorktreeNoteService; bookmarks?: BookmarkService; commandCatalog?: CommandCatalogService; cleanup?: CleanupService; dashboardUpdates?: DashboardUpdates<DashboardPayload>; reviewTours?: ReviewTourService; reviewStore?: ReviewTourStore; workspaceFiles?: WorkspaceFileService; serverAdmin?: ServerAdminService; accounts?: CodexAccountService; instanceStatusPoller?: Pick<RemoteInstanceStatusPoller, 'statuses'> };
// derive one stable opaque scratch persistence group
const scratchSaveKey = (workspace: string) => `scratch_${createHash('sha256').update(workspace).digest('base64url').slice(0, 40)}`;
// bound full history scans
const logMetadataRefreshMs = 30_000;
const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {});
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
  const auth = deps.auth ?? new AuthService(process.env.RAC_PASSWORD_HASH ?? '', process.env.RAC_SESSION_SECRET ?? ''); const control = deps.control ?? new ControlService(); const devices = deps.devices ?? new DeviceService(); const tmux = deps.tmux ?? new TmuxAdapter(); const discovery = deps.discovery ?? new DiscoveryService(undefined, tmux); const tickets = deps.tickets ?? new TicketStore(); const launch = deps.launch ?? new LaunchService(config); const promptHistory = deps.promptHistory ?? new PromptHistoryService(); const queuedPrompts = deps.queuedPrompts ?? new QueuedPromptService(); const savedPrompts = deps.savedPrompts ?? new SavedPromptService(); const prompts = new PromptService(discovery, tmux, config.worktrees, promptHistory, queuedPrompts, savedPrompts); const notes = deps.notes ?? new WorktreeNoteService(); const bookmarks = deps.bookmarks ?? new BookmarkService(); const commandCatalog = deps.commandCatalog ?? new CommandCatalogService(); const workspaceFiles = deps.workspaceFiles ?? new WorkspaceFileService(); const push = deps.push ?? new PushService(); const notifications = deps.notifications ?? new AgentNotificationCoordinator(() => {}); const cleanup = deps.cleanup ?? new CleanupService(discovery, undefined, tmux); const stackCommands = new WorktreeCommandService(config); const prSwitch = deps.prSwitch ?? new PullRequestSwitchService(config, discovery, tmux); const newTask = deps.newTask ?? new NewTaskService(config, discovery, tmux); const dashboardUpdates = deps.dashboardUpdates ?? new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.worktrees, dashboard.cleanupPending, dashboard.reviewTour, dashboard.reviews])); const reviewTours = deps.reviewTours ?? new ReviewTourService(discovery, config.worktrees, new CodexExecReviewTourGenerator()); const reviewStore = deps.reviewStore ?? new ReviewTourStore(); const serverAdmin = deps.serverAdmin ?? new ServerAdminService(config); const reviewJobs = new ReviewTourJobs(reviewTours, reviewStore, () => dashboardUpdates.refresh().then(() => undefined)); const reviewTourCapability = await reviewTours.capability();
  const accounts = deps.accounts ?? new CodexAccountService();
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
  const integrationConfig = config.integrations ?? defaultIntegrationConfig;
  // prefer a dedicated federation secret while retaining existing deployments
  const instanceStatusSecret = process.env.RAC_INSTANCE_STATUS_SECRET ?? process.env.RAC_SESSION_SECRET ?? '';
  const instanceStatusPoller = deps.instanceStatusPoller ?? new RemoteInstanceStatusPoller(instanceStatusSecret);
  const projectProxy = new ProjectProxy(config.worktrees, config.publicOrigin.origin, process.env.RAC_PROJECT_PROXY_HOST);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65_536 }); const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url)); const uiVersion = async () => await readFile(join(webRoot, 'index.html'), 'utf8').then(html => /<script[^>]+src="([^"]+)"/u.exec(html)?.[1]).catch(() => undefined); await app.register(cookie); await app.register(staticPlugin, { root: webRoot, index: false }); await app.register(rateLimit, { global: false }); await app.register(websocket, { options: { maxPayload: 65_536 } });
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
  const projectFrameSources = [...new Set(config.worktrees.flatMap(worktree => worktree.projectUrl === undefined ? [] : [new URL(worktree.projectUrl).origin]))];
  const frameSourcePolicy = `frame-src 'self'${projectFrameSources.length === 0 ? '' : ` ${projectFrameSources.join(' ')}`}`;
  const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 });
  const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const inactiveClient = () => Object.assign(new Error('another client is active'), { statusCode: 423 });
  function browser(request: FastifyRequest, mutation = false): void { if (request.headers.host !== expectedHost) throw forbidden(); if (mutation && request.headers.origin !== config.publicOrigin.origin) throw forbidden(); }
  function session(request: FastifyRequest, mutation = false): Session { browser(request, mutation); const s = auth.get(auth.unsign(request.cookies[cookieName])); if (!s) throw unauthorized(); if (mutation && !auth.csrf(s, request.headers['x-csrf-token'] as string | undefined)) throw forbidden(); return s; }
  function controlled(request: FastifyRequest, mutation = false): Session { const s = session(request, mutation); if (!control.connect(s.id)) throw inactiveClient(); return s; }
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
    const worktree = configuredWorktreeForWorkspace(config.worktrees, agent.workspace);
    return worktree === undefined ? `agent:${agent.id}` : `worktree:${worktree.id}`;
  };
  // count prompts before dispatch starts
  const queuedPromptCounts = async (agents: Agent[]) => new Map(await Promise.all(agents.map(async agent => {
    // suppress false completion alerts on storage errors
    const count = await queuedPrompts.list(promptStorageKeyForAgent(agent)).then(queue => queue?.length ?? 0).catch(() => 1);
    return [agent.id, count] as const;
  })));
  const dashboard = async (): Promise<DashboardPayload> => {
    const discovered = await discovery.dashboard(config.worktrees);
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    await Promise.all(discovered.agents.map(agent => prompts.observe(agent).catch(() => undefined)));
    // suppress completions while more work waits
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0);
    notifications.retain(discovered.agents);
    const controls = new Map(await Promise.all(config.worktrees.map(async worktree => [worktree.id, { actions: stackCommands.actions(worktree), ...await stackCommands.state(worktree) }] as const)));
    const controlFor = (worktreeId: string | undefined) => worktreeId === undefined ? undefined : controls.get(worktreeId);
    const reviewBranches = config.worktrees.map(worktree => ({ worktreeId: worktree.id, branch: discovered.agents.find(agent => agent.worktreeId === worktree.id)?.branch ?? discovered.worktrees.find(candidate => candidate.id === worktree.id)?.branch }));
    const reviews = await reviewStore.summaries(reviewBranches);
    return { ...discovered, agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent), queuedPromptCount: queuedCounts.get(agent.id) ?? 0, ...(controlFor(agent.worktreeId) === undefined ? {} : { stack: controlFor(agent.worktreeId) }) })), worktrees: discovered.worktrees.map(worktree => ({ ...worktree, ...(sleepingWorktrees.has(worktree.id) ? { sleeping: true } : {}), ...(controlFor(worktree.id) === undefined ? {} : { stack: controlFor(worktree.id) }) })), cleanupPending: cleanup.pending().length, reviewTour: reviewTourCapability, reviews };
  };
  // observe only agent state needed by cross-instance attention
  const localInstanceAttention = async () => {
    const discovered = await discovery.dashboard(config.worktrees);
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    // update completion and question state for every agent
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0);
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
    const realtime = new RealtimeService({ apiKey: process.env.RAC_OPENAI_API_KEY });
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
  // stop every advisor tied to one reviewed target
  const stopUpdateAdvisors = async (targetSha: string): Promise<boolean> => {
    const advisorIds = new Set<string>();
    const mappedId = updateAdvisors.get(targetSha);
    // include the in-memory target after an uninterrupted launch
    if (mappedId !== undefined) advisorIds.add(mappedId);
    let dashboard;
    try {
      dashboard = await discovery.dashboard(config.worktrees);
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
    const available = await serverAdmin.updateAvailable();
    // require the configured host bridge
    return available === undefined ? reply.code(503).send({ error: 'Server update checks are unavailable on this deployment.' }) : { available };
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
  const configuredWorktree = (id: string) => config.worktrees.find(worktree => worktree.id === id);
  // resolve one configured shared persistence group
  const worktreeSaveKey = (id: string) => {
    const worktree = configuredWorktree(id);
    return worktree === undefined ? undefined : worktree.saveKey ?? worktree.id;
  };
  // resolve durable persistence for one live agent
  const agentPersistence = async (id: string) => {
    const target = await discovery.target(id);
    // require one current agent target
    if (target === undefined) return undefined;
    const worktree = configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    return { agent: target.agent, worktree, saveKey: worktree?.saveKey ?? worktree?.id ?? scratchSaveKey(target.agent.workspace) };
  };
  // resolve the observed branch for one configured worktree
  const reviewBranch = async (id: string): Promise<string | undefined> => {
    const discovered = await discovery.dashboard(config.worktrees);
    return discovered.agents.find(agent => agent.worktreeId === id)?.branch ?? discovered.worktrees.find(worktree => worktree.id === id)?.branch;
  };
  app.get('/api/worktrees/:id/notes', async (request, reply) => { controlled(request); const id = (request.params as { id: string }).id; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const stored = await notes.list(saveKey); return stored === undefined ? reply.code(400).send({ error: 'invalid worktree' }) : { notes: stored }; });
  // create an optionally titled note
  app.post('/api/worktrees/:id/notes', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const saveKey = worktreeSaveKey(id); const title = body(request).title; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0'))) return reply.code(400).send({ error: 'invalid note title' }); const note = await notes.create(saveKey, title as string | undefined); return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(note); });
  app.put('/api/worktrees/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); const text = body(request).text; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' }); const note = await notes.update(saveKey, noteId, text); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  // rename one note
  app.patch('/api/worktrees/:id/notes/:noteId', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); const title = body(request).title; if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid note title' }); const note = await notes.rename(saveKey, noteId, title); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  app.delete('/api/worktrees/:id/notes/:noteId', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = worktreeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const note = await notes.delete(saveKey, noteId); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  // list one live agent's notes
  app.get('/api/agents/:id/notes', async (request, reply) => {
    controlled(request);
    const persistence = await agentPersistence((request.params as { id: string }).id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const stored = await notes.list(persistence.saveKey);
    return stored === undefined ? reply.code(400).send({ error: 'invalid note group' }) : { notes: stored };
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
  // list one worktree's shared chat bookmarks
  app.get('/api/worktrees/:id/bookmarks', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const agentId = (request.query as { agentId?: unknown }).agentId;
    const saveKey = worktreeSaveKey(id);
    // require one configured group
    if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // reject malformed agent context
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) return reply.code(400).send({ error: 'invalid agent' });
    const stored = await bookmarks.list(saveKey);
    // require one valid shared group
    if (stored === undefined) return reply.code(400).send({ error: 'invalid bookmark group' });
    let currentBookmarkId: string | undefined;
    // resolve current state only for the live worktree agent
    if (typeof agentId === 'string') {
      const target = await discovery.target(agentId);
      const targetWorktree = target === undefined ? undefined : configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
      // ignore stale or mismatched agent identities
      if (targetWorktree?.id === id) {
        const threadId = await discovery.conversationId(agentId);
        currentBookmarkId = stored.find(bookmark => bookmark.threadId === threadId)?.id;
      }
    }
    return { bookmarks: stored, canResume: launch.canResumeConversation(id), ...(currentBookmarkId === undefined ? {} : { currentBookmarkId }) };
  });
  // list one live agent's chat bookmarks
  app.get('/api/agents/:id/bookmarks', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const persistence = await agentPersistence(id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const stored = await bookmarks.list(persistence.saveKey);
    // require one valid shared group
    if (stored === undefined) return reply.code(400).send({ error: 'invalid bookmark group' });
    const threadId = await discovery.conversationId(id);
    const currentBookmarkId = stored.find(bookmark => bookmark.threadId === threadId)?.id;
    return { bookmarks: stored, canResume: persistence.worktree !== undefined && launch.canResumeConversation(persistence.worktree.id), ...(currentBookmarkId === undefined ? {} : { currentBookmarkId }) };
  });
  // bookmark the current top-level Codex chat
  app.post('/api/agents/:id/bookmarks', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const persistence = await agentPersistence(id);
    // require one live agent
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const conversation = await discovery.conversation(id);
    // require one exact pane-to-conversation mapping
    if (conversation === undefined) return reply.code(409).send({ error: 'This agent has an ambiguous or unavailable conversation.' });
    // `create` omits a `codex` kind on disk, so pass the kind through unconditionally
    const bookmark = await bookmarks.create(persistence.saveKey, { threadId: conversation.id, title: conversation.title ?? `Conversation ${conversation.id.slice(0, 8)}`, createdAt: new Date().toISOString(), kind: persistence.agent.kind });
    return bookmark === undefined ? reply.code(409).send({ error: 'This agent has an ambiguous or unavailable conversation.' }) : reply.code(201).send(bookmark);
  });
  // rename one shared chat bookmark
  app.patch('/api/worktrees/:id/bookmarks/:bookmarkId', async (request, reply) => {
    controlled(request, true);
    const { id, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const saveKey = worktreeSaveKey(id);
    const title = body(request).title;
    // require one configured group
    if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    // require one bounded display title
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid bookmark title' });
    const renamed = await bookmarks.rename(saveKey, bookmarkId, title);
    return renamed === undefined ? reply.code(404).send({ error: 'bookmark unavailable' }) : renamed;
  });
  // remove one shared chat bookmark
  app.delete('/api/worktrees/:id/bookmarks/:bookmarkId', async (request, reply) => {
    controlled(request, true);
    const { id, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const saveKey = worktreeSaveKey(id);
    // require one configured group
    if (saveKey === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const removed = await bookmarks.remove(saveKey, bookmarkId);
    return removed === undefined ? reply.code(404).send({ error: 'bookmark unavailable' }) : removed;
  });
  // rename one live agent chat bookmark
  app.patch('/api/agents/:id/bookmarks/:bookmarkId', async (request, reply) => {
    controlled(request, true);
    const { id, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const persistence = await agentPersistence(id);
    const title = body(request).title;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require one bounded display title
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid bookmark title' });
    const renamed = await bookmarks.rename(persistence.saveKey, bookmarkId, title);
    return renamed === undefined ? reply.code(404).send({ error: 'bookmark unavailable' }) : renamed;
  });
  // delete one live agent chat bookmark
  app.delete('/api/agents/:id/bookmarks/:bookmarkId', async (request, reply) => {
    controlled(request, true);
    const { id, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const persistence = await agentPersistence(id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const removed = await bookmarks.remove(persistence.saveKey, bookmarkId);
    return removed === undefined ? reply.code(404).send({ error: 'bookmark unavailable' }) : removed;
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
    const worktree = configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    const scopedAgent = worktree === undefined ? target.agent : { ...target.agent, worktreeId: worktree.id };
    notifications.view(scopedAgent);
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/switch-prs', async (request, reply) => { controlled(request); const availability = await prSwitch.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'pull request switching unavailable' }) : availability; });
  app.get('/api/agents/:id/github-actions', async (request, reply) => { controlled(request); const url = await prSwitch.actionsUrl((request.params as { id: string }).id); return url === undefined ? reply.code(404).send({ error: 'GitHub Actions unavailable' }) : { url }; });
  app.post('/api/agents/:id/switch-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number) || !await prSwitch.switch((request.params as { id: string }).id, number as number)) return reply.code(409).send({ error: 'Unable to switch to that pull request. The worktree must be clean and pushed.' }); return reply.code(202).send(); });
  // move one occupied pull request into the requested agent worktree
  app.post('/api/agents/:id/move-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number)) return reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); const result = await prSwitch.move((request.params as { id: string }).id, number as number); if (result === 'recovery-required') return reply.code(409).send({ error: 'The pull request move needs manual recovery. Check both worktrees; any unrecovered changes remain safely stored in Git stash.', recoveryRequired: true }); return result === 'moved' ? reply.code(202).send() : reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); });
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
  const savedPromptKey = async (agentId: string) => {
    const key = await promptStorageKey(agentId);
    return key?.startsWith('agent:') ? key.slice('agent:'.length) : key;
  };
  app.get('/api/agents/:id/saved-prompts', async (request, reply) => { controlled(request); const key = await savedPromptKey((request.params as { id: string }).id); if (key === undefined) return reply.code(404).send({ error: 'target unavailable' }); const prompts = await savedPrompts.list(key); return prompts === undefined ? reply.code(400).send({ error: 'invalid agent' }) : { prompts }; });
  app.get('/api/agents/:id/commands', async (request, reply) => {
    controlled(request);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const adapter = adapterFor(target.agent.kind);
    // an Adapter without a command catalog serves an empty one
    if (adapter === undefined) return { commands: [] };
    const worktree = configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    // resolve the service-visible codex state directory
    const stateDirectory = process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex');
    return { commands: await commandCatalog.catalog(adapter, worktree?.path ?? target.agent.workspace, stateDirectory) };
  });
  // list workspace files referenced by one completed response
  app.post('/api/agents/:id/message-files', async (request, reply) => {
    controlled(request, true);
    const message = body(request).message;
    if (typeof message !== 'string' || message.length > 30_000 || message.includes('\0')) return reply.code(400).send({ error: 'invalid assistant message' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    return { files: await workspaceFiles.list(worktree?.identity ?? target.agent.workspace, message) };
  });
  // preview one workspace file or bounded host temporary screenshot
  app.post('/api/agents/:id/file-preview', async (request, reply) => {
    controlled(request, true);
    const path = body(request).path;
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    const panePid = discovery.paneProcessId(target.agent.id);
    // fall back only to the image-only host temporary bridge
    const preview = await workspaceFiles.preview(worktree?.identity ?? target.agent.workspace, path) ?? await workspaceFiles.previewTemporaryImage(path, panePid);
    return preview === undefined ? reply.code(404).send({ error: 'file unavailable' }) : preview;
  });
  app.post('/api/agents/:id/saved-prompts', { bodyLimit: Math.ceil(maxPromptAttachmentBytes * 1.4) }, async (request, reply) => { controlled(request, true); const key = await savedPromptKey((request.params as { id: string }).id); const data = body(request); const attachments = promptAttachments(data.attachments); if (key === undefined) return reply.code(404).send({ error: 'target unavailable' }); if (typeof data.prompt !== 'string' || attachments === undefined) return reply.code(400).send({ error: 'invalid prompt' }); const saved = await savedPrompts.save(key, data.prompt, attachments); return saved === undefined ? reply.code(400).send({ error: 'invalid prompt' }) : reply.code(201).send(saved); });
  app.post('/api/agents/:id/queued-prompts/:promptId/save', async (request, reply) => {
    controlled(request, true);
    const { id, promptId } = request.params as { id: string; promptId: string };
    const [queueKey, savedKey] = await Promise.all([promptStorageKey(id), savedPromptKey(id)]);
    if (queueKey === undefined || savedKey === undefined) return reply.code(404).send({ error: 'target unavailable' });
    let saved: Awaited<ReturnType<SavedPromptService['save']>>;
    const result = await queuedPrompts.consumeOnSuccess(queueKey, promptId, async queued => {
      saved = await savedPrompts.save(savedKey, queued.text, queued.attachments ?? []);
      return saved !== undefined;
    });
    if (result === 'missing') return reply.code(404).send({ error: 'queued prompt unavailable' });
    if (result === 'failed' || saved === undefined) return reply.code(409).send({ error: 'unable to save queued prompt' });
    return reply.code(201).send(saved);
  });
  app.post('/api/agents/:id/saved-prompts/:promptId/queue', async (request, reply) => {
    controlled(request, true);
    const { id, promptId } = request.params as { id: string; promptId: string };
    const key = await savedPromptKey(id);
    if (key === undefined) return reply.code(404).send({ error: 'target unavailable' });
    const result = await savedPrompts.consumeOnSuccess(key, promptId, saved => prompts.submit(id, saved.text, saved.attachments ?? []));
    if (result === 'missing') return reply.code(404).send({ error: 'saved prompt unavailable' });
    if (result === 'failed') return reply.code(409).send({ error: 'unable to queue saved prompt' });
    return reply.code(204).send();
  });
  app.delete('/api/agents/:id/saved-prompts/:promptId', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; const key = await savedPromptKey(id); if (key === undefined) return reply.code(404).send({ error: 'target unavailable' }); const prompt = await savedPrompts.consume(key, promptId); return prompt === undefined ? reply.code(404).send({ error: 'saved prompt unavailable' }) : prompt; });
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
  app.delete('/api/agents/:id', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || config.worktrees.some(worktree => worktreeMatchesWorkspace(worktree, target.agent.workspace)) || !await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  // permanently close one idle configured agent
  app.post('/api/agents/:id/deactivate', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const target = await discovery.target(id);
    const worktree = target === undefined ? undefined : configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
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
    const worktree = target === undefined ? undefined : configuredWorktreeForWorkspace(config.worktrees, target.agent.workspace);
    // limit sleep to the same idle configured agents as turn off
    if (!target || worktree === undefined || agentAttentionState(target.agent) === 'working') return reply.code(409).send({ error: 'only idle configured agents can sleep' });
    // require a live target
    if (!await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' });
    sleepingWorktrees.add(worktree.id);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.post('/api/agents/:id/question', async (request, reply) => { controlled(request, true); const data = body(request); if (typeof data.questionId !== 'string' || !Number.isInteger(data.index) || !await prompts.answerQuestion((request.params as { id: string }).id, data.questionId, data.index as number)) return reply.code(404).send({ error: 'question unavailable' }); return reply.code(204).send(); });
  const launchReadyTimeoutSeconds = 60;
  const launchPollIntervalMs = 250;
  const launchPollAttempts = launchReadyTimeoutSeconds * 1_000 / launchPollIntervalMs;
  // delay between launch checks
  const launchPollDelay = deps.launchPollDelay ?? (async () => await new Promise(resolve => setTimeout(resolve, launchPollIntervalMs)));
  // wait for slow agent startup
  const waitForAgent = async (before: Set<string>, worktreeId?: string, displayLabel?: string) => {
    // poll for up to sixty seconds
    for (let attempt = 0; attempt < launchPollAttempts; attempt += 1) {
      const dashboard = await discovery.dashboard(config.worktrees);
      const agent = dashboard.agents.find(candidate => !before.has(candidate.id)
        && (worktreeId === undefined || candidate.worktreeId === worktreeId)
        && (displayLabel === undefined || candidate.displayLabel === displayLabel));
      // return the ready agent
      if (agent) return agent;
      // pause before retrying
      if (attempt + 1 < launchPollAttempts) await launchPollDelay();
    }
    return undefined;
  };
  // launch and pre-prompt one dedicated update advisor
  const launchUpdateAdvisor = async (targetSha: string): Promise<string | undefined> => {
    const preview = await serverAdmin.updatePreview();
    // require the exact current advisory range
    if (preview === undefined || preview.targetSha !== targetSha) return undefined;
    const advisor = serverAdmin.updateAdvisor(preview);
    // require a server-owned advisor request
    if (advisor === undefined) return undefined;
    const dashboard = await discovery.dashboard(config.worktrees);
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
  const restartIdleConfiguredAgent = async (id: string, expectedWorktreeId?: string, expectedMutationVersion?: number, expectedMutationGeneration?: number, threadId?: string): Promise<IdleRestartResult> => {
    const releaseRestart = await prompts.acquireRestartLock(id, expectedMutationVersion, expectedMutationGeneration);
    // reject overlapping prompt and lifecycle work
    if (releaseRestart === undefined) return { status: 'skipped', worktreeId: expectedWorktreeId ?? 'unknown', reason: 'not-idle', error: 'The worktree is no longer idle.' };
    try {
      const current = await discovery.dashboard(config.worktrees, true);
      const observed = current.agents.find(agent => agent.id === id);
      const worktree = observed === undefined ? undefined : configuredWorktreeForWorkspace(config.worktrees, observed.workspace);
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
      const resumed = threadId === undefined ? await launch.resume(worktree.id) : await launch.resumeConversation(worktree.id, threadId);
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
      const discovered = await discovery.dashboard(config.worktrees);
      const queuedCounts = await queuedPromptCounts(discovered.agents);
      const byWorktree = new Map<string, Agent[]>();
      // group only open configured worktrees
      for (const agent of discovered.agents) {
        // ignore scratch and stale configured identifiers
        if (agent.worktreeId === undefined || config.worktrees.every(worktree => worktree.id !== agent.worktreeId)) continue;
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
  // switch one worktree into an exact bookmarked Codex chat
  app.post('/api/worktrees/:id/bookmarks/:bookmarkId/switch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const worktree = configuredWorktree(id);
    // require one configured worktree
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const bookmark = await bookmarks.get(worktree.saveKey ?? worktree.id, bookmarkId);
    // require one bookmark in the configured group
    if (bookmark === undefined) return reply.code(404).send({ error: 'bookmark unavailable' });
    // resume through the bookmark's own Adapter (absent kind = codex)
    if (adapterFor(bookmark.kind ?? 'codex')?.conversations?.validId(bookmark.threadId) !== true) return reply.code(409).send({ error: 'This bookmark cannot be resumed.' });
    // fail before any destructive handoff
    if (!launch.canResumeConversation(worktree.id)) return reply.code(409).send({ error: 'Exact chat resume is not configured for this worktree.' });
    const selectionMutationGeneration = prompts.mutationGeneration();
    const current = await discovery.dashboard(config.worktrees, true);
    const open = current.agents.filter(agent => agent.worktreeId === worktree.id);
    // avoid an ambiguous destructive handoff
    if (open.length > 1) return reply.code(409).send({ error: 'Close duplicate worktree agents before switching chats.' });
    const activeAgent = open[0];
    // restart one existing idle agent safely
    if (activeAgent !== undefined) {
      const result = await restartIdleConfiguredAgent(activeAgent.id, worktree.id, prompts.mutationVersion(activeAgent.id), selectionMutationGeneration, bookmark.threadId);
      // return one successful replacement
      if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
      // distinguish stale targets from active work
      if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
      return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
    }
    const before = new Set(current.agents.map(agent => agent.id));
    // launch inactive worktrees directly into the bookmark
    if (!await launch.resumeConversation(worktree.id, bookmark.threadId)) return reply.code(409).send({ error: 'Could not resume the bookmarked chat.' });
    const agent = await waitForAgent(before, worktree.id);
    // surface slow or failed resume handoffs
    if (agent === undefined) return reply.code(504).send({ error: `The bookmarked chat started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    sleepingWorktrees.delete(worktree.id);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ agentId: agent.id });
  });
  // restart one idle configured agent by resuming its last conversation
  app.post('/api/agents/:id/restart', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const mutationGeneration = prompts.mutationGeneration();
    const result = await restartIdleConfiguredAgent(id, undefined, prompts.mutationVersion(id), mutationGeneration);
    // return one successful replacement
    if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
    // distinguish missing targets from active work
    if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
    return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
  });
  app.post('/api/worktrees/:id/launch', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    // require a successful launch handoff
    if (!await launch.launch(worktreeId)) return reply.code(409).send({ error: 'Could not start the worktree agent.' });
    sleepingWorktrees.delete(worktreeId);
    const agent = await waitForAgent(before, worktreeId);
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The worktree session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
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
    // reject ordinary inactive worktrees
    if (configuredWorktree(worktreeId) === undefined || !sleepingWorktrees.has(worktreeId)) return reply.code(409).send({ error: 'worktree is not sleeping' });
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    // require a successful resume handoff
    if (!await launch.resume(worktreeId)) return reply.code(409).send({ error: 'Could not resume the worktree agent.' });
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
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    if (!await launch.launchHome()) return reply.code(409).send({ error: 'Could not start a new agent session.' });
    const agent = await waitForAgent(before);
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The new session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  app.post('/api/agents/:id/tickets', async (request, reply) => { const s = controlled(request, true); const kind = body(request).kind; if (kind !== 'input' && kind !== 'logs' && kind !== 'terminal') return reply.code(400).send({ error: 'invalid ticket type' }); const target = await discovery.target((request.params as { id: string }).id); if (!target) return reply.code(404).send({ error: 'target unavailable' }); return { ticket: tickets.mint(s.id, kind as TicketKind, kind === 'terminal' ? target.agent.sessionId : target.agent.id).id }; });
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
        (nextCols, nextRows) => tmux.resize(target.socket, target.agent.paneId, nextCols, nextRows)
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
            if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300) throw new Error();
            cols = frame.cols;
            rows = frame.rows;
            viewportEstablished = true;
            void viewport.schedule({ cols, rows, history, onFailure: () => socket.close(1011) });
            return;
          }
          if (frame.type === 'history') {
            if (!Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > 5_000) throw new Error();
            const hasViewport = frame.cols !== undefined || frame.rows !== undefined;
            if (hasViewport && (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300)) throw new Error();
            if (!hasViewport) { requestView(frame.offset); return; }
            cols = frame.cols;
            rows = frame.rows;
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
  app.get('/ws/terminal/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || !tickets.consume(ticket, s.id, 'terminal', target.agent.sessionId)) throw new Error(); const sessionName = target.agent.sessionId.slice(target.agent.socketFingerprint.length + 1); const terminal = pty.spawn(process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', target.socket.path, 'attach-session', '-t', sessionName], { name: 'xterm-256color', cols: 120, rows: 36, cwd: '/', env: safeEnv() as Record<string, string> }); terminal.onData(value => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ v: 1, type: 'output', data: Buffer.from(value).toString('base64url') }))); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || typeof frame?.type !== 'string') throw new Error(); if (frame.type === 'resize') { if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300) throw new Error(); terminal.resize(frame.cols, frame.rows); return; } if (frame.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); const releaseMutation = prompts.beginAgentMutation(id); if (releaseMutation === undefined) throw new Error(); try { terminal.write(decoded.toString('utf8')); } finally { releaseMutation(); } } catch { socket.close(1008); } }); const close = () => terminal.kill(); socket.on('close', close); terminal.onExit(() => socket.close()); } catch { socket.close(1008); } });
  app.addHook('onClose', async () => { reviewJobs.close(); await accounts.close(); await paneViewports.restoreAll(); dashboardUpdates.close(); });
  return app;
}
