import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './tmux/command.js';
import type { ValidatedConfig } from './config/schema.js';
import { AuthService, type Session } from './auth/service.js';
import { ControlService } from './auth/control.js';
import { DeviceService } from './auth/devices.js';
import { TicketStore, type TicketKind } from './auth/tickets.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { maxPromptAttachments, maxPromptAttachmentBytes, PromptService, type PromptAttachment } from './prompts/service.js';
import { QueuedPromptService } from './prompts/queue.js';
import { LaunchService } from './launch/service.js';
import * as pty from 'node-pty';
import { safeEnv } from './tmux/command.js';
import { PushService } from './push-service.js';
import { WorktreeCommandService } from './worktree-commands/service.js';
import { PullRequestSwitchService } from './pull-requests/switch-service.js';
import { NewTaskService } from './new-task/service.js';
import { SavedPromptService } from './saved-prompts/service.js';
import { AgentNotificationCoordinator, agentNotificationTag } from './notifications.js';
import { stackActions, type StackAction } from './domain/models.js';
import { SkillService } from './skills/service.js';
import { LatestViewportScheduler, PaneViewportCoordinator } from './logs/viewport-scheduler.js';
import { DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { WorktreeNoteService } from './notes/service.js';
import { CleanupService } from './cleanup/service.js';
import { PromptHistoryService } from './prompt-history/service.js';

export type Dependencies = { auth?: AuthService; control?: ControlService; devices?: DeviceService; discovery?: DiscoveryService; tmux?: TmuxAdapter; tickets?: TicketStore; launch?: LaunchService; push?: PushService; notifications?: AgentNotificationCoordinator; prSwitch?: PullRequestSwitchService; newTask?: NewTaskService; savedPrompts?: SavedPromptService; promptHistory?: PromptHistoryService; queuedPrompts?: QueuedPromptService; notes?: WorktreeNoteService; skills?: SkillService; cleanup?: CleanupService; dashboardUpdates?: DashboardUpdates<DashboardPayload> };
const cookieName = '__Host-rac';
const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {});
const promptAttachments = (value: unknown): PromptAttachment[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxPromptAttachments) return undefined;
  const attachments = value.map(candidate => candidate !== null && typeof candidate === 'object' && typeof (candidate as { name?: unknown }).name === 'string' && typeof (candidate as { data?: unknown }).data === 'string' ? candidate as PromptAttachment : undefined);
  return attachments.some(attachment => attachment === undefined) ? undefined : attachments as PromptAttachment[];
};
type LogFrame = { type: 'append'|'reset'; text: string };
export function logFrame(last: string, value: string): LogFrame | undefined {
  if (!value.trim() || value === last) return undefined;
  // Captures are complete viewport frames. Replaying a guessed suffix can
  // preserve cells that tmux already redrew, producing a mixed old/new frame.
  return { type: 'reset', text: value };
}
export async function buildApp(config: ValidatedConfig, deps: Dependencies = {}): Promise<FastifyInstance> {
  const auth = deps.auth ?? new AuthService(process.env.RAC_PASSWORD_HASH ?? '', process.env.RAC_SESSION_SECRET ?? ''); const control = deps.control ?? new ControlService(); const devices = deps.devices ?? new DeviceService(); const tmux = deps.tmux ?? new TmuxAdapter(); const discovery = deps.discovery ?? new DiscoveryService(undefined, tmux); const tickets = deps.tickets ?? new TicketStore(); const launch = deps.launch ?? new LaunchService(config); const promptHistory = deps.promptHistory ?? new PromptHistoryService(); const queuedPrompts = deps.queuedPrompts ?? new QueuedPromptService(); const prompts = new PromptService(discovery, tmux, config.worktrees, promptHistory, queuedPrompts); const savedPrompts = deps.savedPrompts ?? new SavedPromptService(); const notes = deps.notes ?? new WorktreeNoteService(); const skills = deps.skills ?? new SkillService(); const push = deps.push ?? new PushService(); const notifications = deps.notifications ?? new AgentNotificationCoordinator(() => {}); const cleanup = deps.cleanup ?? new CleanupService(discovery, undefined, tmux); const stackCommands = new WorktreeCommandService(config); const prSwitch = deps.prSwitch ?? new PullRequestSwitchService(config, discovery, tmux); const newTask = deps.newTask ?? new NewTaskService(config, discovery, tmux); const dashboardUpdates = deps.dashboardUpdates ?? new DashboardUpdates<DashboardPayload>(dashboard => JSON.stringify([dashboard.agents, dashboard.worktrees, dashboard.cleanupPending]));
  const paneViewports = new PaneViewportCoordinator();
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65_536 }); const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url)); const uiVersion = async () => await readFile(join(webRoot, 'index.html'), 'utf8').then(html => /<script[^>]+src="([^"]+)"/u.exec(html)?.[1]).catch(() => undefined); await app.register(cookie); await app.register(staticPlugin, { root: webRoot, index: false }); await app.register(rateLimit, { global: false }); await app.register(websocket, { options: { maxPayload: 65_536 } });
  const expectedHost = config.publicOrigin.host;
  const projectFrameSources = [...new Set(config.worktrees.flatMap(worktree => worktree.projectUrl === undefined ? [] : [new URL(worktree.projectUrl).origin]))];
  const frameSourcePolicy = `frame-src 'self'${projectFrameSources.length === 0 ? '' : ` ${projectFrameSources.join(' ')}`}`;
  const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 });
  const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const inactiveClient = () => Object.assign(new Error('another client is active'), { statusCode: 423 });
  function browser(request: FastifyRequest, mutation = false): void { if (request.headers.host !== expectedHost) throw forbidden(); if (mutation && request.headers.origin !== config.publicOrigin.origin) throw forbidden(); }
  function session(request: FastifyRequest, mutation = false): Session { browser(request, mutation); const s = auth.get(auth.unsign(request.cookies[cookieName])); if (!s) throw unauthorized(); if (mutation && !auth.csrf(s, request.headers['x-csrf-token'] as string | undefined)) throw forbidden(); return s; }
  function controlled(request: FastifyRequest, mutation = false): Session { const s = session(request, mutation); if (!control.connect(s.id)) throw inactiveClient(); return s; }
  const sessionState = async (s: Session, active: boolean) => {
    const owner = control.ownerSessionId();
    return {
      csrfToken: s.csrf,
      active,
      deviceName: await devices.get(s.id),
      controllingDeviceName: owner === undefined ? undefined : await devices.get(owner)
    };
  };
  const dashboard = async (): Promise<DashboardPayload> => {
    const discovered = await discovery.dashboard(config.worktrees);
    await Promise.all(discovered.agents.map(agent => prompts.observe(agent).catch(() => undefined)));
    for (const agent of discovered.agents) notifications.observe(agent);
    notifications.retain(discovered.agents);
    const controls = new Map(await Promise.all(config.worktrees.map(async worktree => [worktree.id, { actions: stackCommands.actions(worktree), ...await stackCommands.state(worktree) }] as const)));
    const controlFor = (worktreeId: string | undefined) => worktreeId === undefined ? undefined : controls.get(worktreeId);
    return { ...discovered, agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent), ...(controlFor(agent.worktreeId) === undefined ? {} : { stack: controlFor(agent.worktreeId) }) })), worktrees: discovered.worktrees.map(worktree => ({ ...worktree, ...(controlFor(worktree.id) === undefined ? {} : { stack: controlFor(worktree.id) }) })), cleanupPending: cleanup.pending().length };
  };
  dashboardUpdates.setLoader(dashboard);
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store').header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains').header('X-Frame-Options', 'DENY').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()').header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', `default-src 'self'; connect-src 'self' wss://${expectedHost}; style-src 'self' 'unsafe-inline'; ${frameSourcePolicy}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`); return payload; });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/', async (request, reply) => { browser(request); return reply.sendFile('index.html'); });
  app.get('/api/ui-version', async (request) => { browser(request); return { version: await uiVersion() }; });
  app.get('/api/auth/session', async (request) => { const s = session(request); return await sessionState(s, control.connect(s.id)); });
  app.get('/api/auth/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { browser(request); return { csrfToken: auth.bootstrap() }; });
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => { browser(request, true); const data = body(request); const preauth = request.headers['x-csrf-token']; if (typeof data.password !== 'string' || typeof preauth !== 'string') return reply.code(401).send({ error: 'invalid credentials' }); const s = await auth.login(data.password, preauth); if (!s) return reply.code(401).send({ error: 'invalid credentials' }); reply.setCookie(cookieName, auth.sign(s), { path: '/', secure: true, httpOnly: true, sameSite: 'lax', signed: false, maxAge: 400 * 24 * 60 * 60 }); return await sessionState(s, control.connect(s.id)); });
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
  app.post('/api/auth/logout', async (request, reply) => { const s = session(request, true); control.release(s.id); auth.logout(s.id); reply.clearCookie(cookieName, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }); return reply.code(204).send(); });
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
  app.get('/api/worktrees/:id/notes', async (request, reply) => { controlled(request); const id = (request.params as { id: string }).id; if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const stored = await notes.list(id); return stored === undefined ? reply.code(400).send({ error: 'invalid worktree' }) : { notes: stored }; });
  app.post('/api/worktrees/:id/notes', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const note = await notes.create(id); return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(note); });
  app.put('/api/worktrees/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const text = body(request).text; if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' }); const note = await notes.update(id, noteId, text); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  app.delete('/api/worktrees/:id/notes/:noteId', async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; if (configuredWorktree(id) === undefined) return reply.code(404).send({ error: 'worktree unavailable' }); const note = await notes.delete(id, noteId); return note === undefined ? reply.code(404).send({ error: 'note unavailable' }) : note; });
  app.get('/api/push/public-key', async (request) => { session(request); return push.enabled ? { publicKey: push.publicKey } : { publicKey: undefined }; });
  app.post('/api/push/subscriptions', async (request, reply) => { session(request, true); return await push.subscribe(body(request) as never) ? reply.code(204).send() : reply.code(400).send({ error: 'invalid push subscription' }); });
  app.post('/api/agents/:id/notifications/dismiss', async (request, reply) => {
    controlled(request, true);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = config.worktrees.find(candidate => target.agent.workspace === candidate.identity || target.agent.workspace === candidate.hostPath);
    const scopedAgent = worktree === undefined ? target.agent : { ...target.agent, worktreeId: worktree.id };
    notifications.view(scopedAgent);
    await push.notify({ kind: 'dismiss', tag: agentNotificationTag(scopedAgent), legacyTag: `agent-status-${target.agent.id}`, ...(worktree === undefined ? {} : { worktreeId: worktree.id }) });
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/switch-prs', async (request, reply) => { controlled(request); const availability = await prSwitch.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'pull request switching unavailable' }) : availability; });
  app.get('/api/agents/:id/github-actions', async (request, reply) => { controlled(request); const url = await prSwitch.actionsUrl((request.params as { id: string }).id); return url === undefined ? reply.code(404).send({ error: 'GitHub Actions unavailable' }) : { url }; });
  app.post('/api/agents/:id/switch-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number) || !await prSwitch.switch((request.params as { id: string }).id, number as number)) return reply.code(409).send({ error: 'Unable to switch to that pull request. The worktree must be clean and pushed.' }); return reply.code(202).send(); });
  app.get('/api/agents/:id/new-task', async (request, reply) => { controlled(request); const availability = await newTask.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'new task unavailable' }) : availability; });
  app.post('/api/agents/:id/new-task', async (request, reply) => { controlled(request, true); if (!await newTask.start((request.params as { id: string }).id)) return reply.code(409).send({ error: 'Unable to start a new task. The working copy must be clean and pushed.' }); return reply.code(202).send(); });
  const promptStorageKey = async (agentId: string) => {
    const target = await discovery.target(agentId);
    if (!target) return undefined;
    const worktree = config.worktrees.find(candidate => target.agent.workspace === candidate.identity || target.agent.workspace === candidate.hostPath);
    return worktree === undefined ? `agent:${agentId}` : `worktree:${worktree.id}`;
  };
  app.post('/api/agents/:id/prompt', { bodyLimit: Math.ceil(maxPromptAttachmentBytes * 1.4) }, async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const attachments = promptAttachments(data.attachments);
    if (typeof data.prompt !== 'string' || attachments === undefined) return reply.code(400).send({ error: 'invalid prompt attachments' });
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
  app.get('/api/agents/:id/skills', async (request, reply) => {
    controlled(request);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = config.worktrees.find(candidate => target.agent.workspace === candidate.identity || target.agent.workspace === candidate.hostPath);
    return { skills: await skills.list(worktree?.path ?? target.agent.workspace) };
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
  app.post('/api/agents/:id/cancel', async (request, reply) => { controlled(request, true); if (!await prompts.cancel((request.params as { id: string }).id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/background', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (!target || !await tmux.suspend(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/review', async (request, reply) => {
    controlled(request, true);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target || !await tmux.suspend(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'target unavailable' });
    if (await tmux.input(target.socket, target.agent.paneId, '\x15review; fg\r')) return reply.code(204).send();
    await tmux.foreground(target.socket, target.agent.paneId);
    return reply.code(500).send({ error: 'review unavailable' });
  });
  app.post('/api/agents/:id/review/close', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (!target || !await tmux.quitReview(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'review unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/foreground', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (!target || !await tmux.foreground(target.socket, target.agent.paneId)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.delete('/api/agents/:id', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || config.worktrees.some(worktree => target.agent.workspace === worktree.identity || target.agent.workspace === worktree.hostPath) || !await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/deactivate', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); const configured = target !== undefined && config.worktrees.some(worktree => target.agent.workspace === worktree.identity || target.agent.workspace === worktree.hostPath); if (!target || !configured || /^[\u2800-\u28ff]/u.test(target.agent.title)) return reply.code(409).send({ error: 'only idle configured agents can be turned off' }); if (!await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/question', async (request, reply) => { controlled(request, true); const index = body(request).index; if (!Number.isInteger(index) || !await prompts.answerOption((request.params as { id: string }).id, index as number)) return reply.code(404).send({ error: 'question unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/omx-question', async (request, reply) => { controlled(request, true); const data = body(request); if (typeof data.questionId !== 'string' || !Number.isInteger(data.index) || !await prompts.answerOmxQuestion((request.params as { id: string }).id, data.questionId, data.index as number)) return reply.code(404).send({ error: 'question unavailable' }); return reply.code(204).send(); });
  const waitForAgent = async (before: Set<string>, worktreeId?: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const dashboard = await discovery.dashboard(config.worktrees);
      const agent = worktreeId === undefined ? dashboard.agents.find(candidate => !before.has(candidate.id)) : dashboard.agents.find(candidate => candidate.worktreeId === worktreeId);
      if (agent) return agent;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return undefined;
  };
  app.post('/api/worktrees/:id/launch', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    if (!await launch.launch(worktreeId)) return reply.code(409).send({ error: 'Could not start the worktree agent.' });
    const agent = await waitForAgent(before, worktreeId);
    if (!agent) return reply.code(504).send({ error: 'The worktree session started, but Codex did not become ready within 20 seconds.' });
    return reply.code(201).send({ agentId: agent.id });
  });
  app.post('/api/worktrees/:id/commands/:action', async (request, reply) => { controlled(request, true); const action = (request.params as { action: string }).action; if (!(stackActions as readonly string[]).includes(action) || !await stackCommands.run((request.params as { id: string }).id, action as StackAction)) return reply.code(404).send({ error: 'stack command unavailable' }); return reply.code(202).send(); });
  app.post('/api/agents/launch', async (request, reply) => {
    controlled(request, true);
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    if (!await launch.launchHome()) return reply.code(409).send({ error: 'Could not start a new agent session.' });
    const agent = await waitForAgent(before);
    if (!agent) return reply.code(504).send({ error: 'The new session started, but Codex did not become ready within 20 seconds.' });
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
          const captured = await tmux.captureWindow(target.socket, target.agent.paneId, requestedHistory, requestedRows);
          if (captured === undefined) return socket.close(1008);
          // A page/viewport request may arrive while tmux is capturing the old
          // window. Never publish that stale window: it makes the next click
          // appear to skip a page.
          if (requestedVersion !== viewVersion) {
            pollQueued = true;
            return;
          }
          if (!captured.text || captured.text === last) return;
          const now = Date.now();
          if (!immediate && lastResetAt && now - lastResetAt < 750) return;
          const frame = requestedHistory === 0 ? logFrame(last, captured.text) : { type: 'reset' as const, text: captured.text };
          last = captured.text;
          lastResetAt = now;
          if (frame !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ v: 1, ...frame, older: captured.older, newer: requestedHistory > 0, ...(captured.lastPrompt === undefined ? {} : { lastPrompt: captured.lastPrompt }), ...(captured.latestAssistantMessage === undefined ? {} : { latestAssistantMessage: captured.latestAssistantMessage, latestAssistantMessageOverflows: captured.latestAssistantMessageOverflows }) }));
        } finally {
          polling = false;
          if (pollQueued) {
            pollQueued = false;
            void poll(true);
          }
        }
      };
      const requestView = (nextHistory: number) => {
        history = nextHistory;
        last = '';
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
          throw new Error();
        } catch { socket.close(1008); }
      });
      socket.on('close', () => { clearInterval(timer); if (paneViewport !== undefined) void paneViewport.release(); });
      await poll();
    } catch { socket.close(1008); }
  });
  app.get('/ws/input/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const id = (request.params as { id: string }).id; if (!tickets.consume(ticket, s.id, 'input', id)) throw new Error(); const target = await discovery.target(id); if (!target) throw new Error(); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || frame?.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (!decoded.length || decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); void tmux.input(target.socket, target.agent.paneId, decoded.toString('utf8')).then(ok => { if (!ok) socket.close(1011); }); } catch { socket.close(1008); } }); } catch { socket.close(1008); } });
  app.get('/ws/terminal/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const target = await discovery.target((request.params as { id: string }).id); if (!target || !tickets.consume(ticket, s.id, 'terminal', target.agent.sessionId)) throw new Error(); const sessionName = target.agent.sessionId.slice(target.agent.socketFingerprint.length + 1); const terminal = pty.spawn(process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', target.socket.path, 'attach-session', '-t', sessionName], { name: 'xterm-256color', cols: 120, rows: 36, cwd: '/', env: safeEnv() as Record<string, string> }); terminal.onData(value => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ v: 1, type: 'output', data: Buffer.from(value).toString('base64url') }))); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || typeof frame?.type !== 'string') throw new Error(); if (frame.type === 'resize') { if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300) throw new Error(); terminal.resize(frame.cols, frame.rows); return; } if (frame.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); terminal.write(decoded.toString('utf8')); } catch { socket.close(1008); } }); const close = () => terminal.kill(); socket.on('close', close); terminal.onExit(() => socket.close()); } catch { socket.close(1008); } });
  app.addHook('onClose', async () => { await paneViewports.restoreAll(); dashboardUpdates.close(); });
  return app;
}
