import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { run } from './tmux/command.js';
import type { ValidatedConfig } from './config/schema.js';
import { AuthService, type Session } from './auth/service.js';
import { ControlService } from './auth/control.js';
import { TicketStore, type TicketKind } from './auth/tickets.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PromptService } from './prompts/service.js';
import { LaunchService } from './launch/service.js';
import * as pty from 'node-pty';
import { safeEnv } from './tmux/command.js';
import { PushService } from './push-service.js';

export type Dependencies = { auth?: AuthService; control?: ControlService; discovery?: DiscoveryService; tmux?: TmuxAdapter; tickets?: TicketStore; launch?: LaunchService; push?: PushService };
const cookieName = '__Host-rac';
const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {});
type LogFrame = { type: 'append'|'reset'; text: string };
export function logFrame(last: string, value: string): LogFrame | undefined {
  if (!value.trim() || value === last) return undefined;
  if (!last) return { type: 'reset', text: value };
  if (value.startsWith(last)) return { type: 'append', text: value.slice(last.length) };
  const limit = Math.min(last.length, value.length, 2_048);
  if (last.startsWith(value.slice(0, limit))) return { type: 'reset', text: value };
  for (let size = limit; size > 0; size -= 1) {
    const overlapStart = last.lastIndexOf(value.slice(0, size));
    if (overlapStart >= 0 && last.slice(overlapStart) === value.slice(0, last.length - overlapStart)) return { type: 'append', text: value.slice(last.length - overlapStart) };
  }
  let shared = 0;
  while (shared < last.length && shared < value.length && last[shared] === value[shared]) shared += 1;
  const lineStart = value.lastIndexOf('\n', shared);
  if (lineStart >= 0 && lineStart < value.length - 1) return { type: 'append', text: value.slice(lineStart) };
  return { type: 'reset', text: value };
}
export async function buildApp(config: ValidatedConfig, deps: Dependencies = {}): Promise<FastifyInstance> {
  const auth = deps.auth ?? new AuthService(process.env.RAC_PASSWORD_HASH ?? '', process.env.RAC_SESSION_SECRET ?? ''); const control = deps.control ?? new ControlService(); const tmux = deps.tmux ?? new TmuxAdapter(); const discovery = deps.discovery ?? new DiscoveryService(undefined, tmux); const tickets = deps.tickets ?? new TicketStore(); const launch = deps.launch ?? new LaunchService(config); const prompts = new PromptService(discovery, tmux, config.worktrees); const push = deps.push ?? new PushService();
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65_536 }); const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url)); const uiVersion = await readFile(join(webRoot, 'index.html'), 'utf8').then(html => /<script[^>]+src="([^"]+)"/u.exec(html)?.[1]).catch(() => undefined); await app.register(cookie); await app.register(staticPlugin, { root: webRoot, index: false }); await app.register(rateLimit, { global: false }); await app.register(websocket, { options: { maxPayload: 65_536 } });
  const expectedHost = config.publicOrigin.host;
  const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 });
  const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const inactiveClient = () => Object.assign(new Error('another client is active'), { statusCode: 423 });
  function browser(request: FastifyRequest, mutation = false): void { if (request.headers.host !== expectedHost) throw forbidden(); if (mutation && request.headers.origin !== config.publicOrigin.origin) throw forbidden(); }
  function session(request: FastifyRequest, mutation = false): Session { browser(request, mutation); const s = auth.get(auth.unsign(request.cookies[cookieName])); if (!s) throw unauthorized(); if (mutation && !auth.csrf(s, request.headers['x-csrf-token'] as string | undefined)) throw forbidden(); return s; }
  function controlled(request: FastifyRequest, mutation = false): Session { const s = session(request, mutation); if (!control.connect(s.id)) throw inactiveClient(); return s; }
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store').header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains').header('X-Frame-Options', 'DENY').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()').header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', `default-src 'self'; connect-src 'self' wss://${expectedHost}; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`); return payload; });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/', async (request, reply) => { browser(request); return reply.sendFile('index.html'); });
  app.get('/api/ui-version', async (request) => { browser(request); return { version: uiVersion }; });
  app.get('/api/auth/session', async (request) => { const s = session(request); return { csrfToken: s.csrf, active: control.connect(s.id) }; });
  app.get('/api/auth/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { browser(request); return { csrfToken: auth.bootstrap() }; });
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => { browser(request, true); const data = body(request); const preauth = request.headers['x-csrf-token']; if (typeof data.password !== 'string' || typeof preauth !== 'string') return reply.code(401).send({ error: 'invalid credentials' }); const s = await auth.login(data.password, preauth); if (!s) return reply.code(401).send({ error: 'invalid credentials' }); reply.setCookie(cookieName, auth.sign(s), { path: '/', secure: true, httpOnly: true, sameSite: 'lax', signed: false, maxAge: 400 * 24 * 60 * 60 }); return { csrfToken: s.csrf, active: control.connect(s.id) }; });
  app.post('/api/auth/take-control', async (request) => { const s = session(request, true); control.take(s.id); return { active: true }; });
  app.post('/api/auth/logout', async (request, reply) => { const s = session(request, true); control.release(s.id); auth.logout(s.id); reply.clearCookie(cookieName, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }); return reply.code(204).send(); });
  app.get('/api/dashboard', async (request) => { controlled(request); return await discovery.dashboard(config.worktrees); });
  app.get('/api/push/public-key', async (request) => { session(request); return push.enabled ? { publicKey: push.publicKey } : { publicKey: undefined }; });
  app.post('/api/push/subscriptions', async (request, reply) => { session(request, true); return await push.subscribe(body(request) as never) ? reply.code(204).send() : reply.code(400).send({ error: 'invalid push subscription' }); });
  app.get('/api/agents/:id/directories', async (request, reply) => {
    controlled(request);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const query = request.query as { path?: unknown };
    const root = await realpath(target.agent.workspace).catch(() => undefined);
    const requested = typeof query.path === 'string' ? await realpath(query.path).catch(() => undefined) : root;
    if (!root || !requested || (requested !== root && relative(root, requested).startsWith('..'))) return reply.code(400).send({ error: 'directory unavailable' });
    const directories = await readdir(requested, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()).catch(() => undefined);
    if (!directories) return reply.code(404).send({ error: 'directory unavailable' });
    return { root, path: requested, directories };
  });
  app.post('/api/agents/:id/directory', async (request, reply) => {
    controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); const path = body(request).path;
    if (!target || typeof path !== 'string') return reply.code(404).send({ error: 'target unavailable' });
    const root = await realpath(target.agent.workspace).catch(() => undefined); const directory = await realpath(path).catch(() => undefined);
    if (!root || !directory || (directory !== root && relative(root, directory).startsWith('..'))) return reply.code(400).send({ error: 'directory unavailable' });
    const sessionName = `rac-${randomBytes(9).toString('hex')}`; const script = `export HOME='/home/ubuntu'\nexport PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"\ncd -- '${directory.replaceAll("'", "'\\''")}' && exec "$HOME/n/bin/codex"`;
    if ((await run(process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', target.socket.path, 'new-session', '-d', '-s', sessionName, '-c', directory, '/bin/bash', '-lc', script])).code !== 0) return reply.code(409).send({ error: 'could not start agent' });
    await tmux.close(target.socket, target.agent.paneId); return reply.code(202).send();
  });
  app.post('/api/agents/:id/prompt', async (request, reply) => { controlled(request, true); const data = body(request); if (typeof data.prompt !== 'string' || !await prompts.submit((request.params as { id: string }).id, data.prompt)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.post('/api/agents/:id/cancel', async (request, reply) => { controlled(request, true); if (!await prompts.cancel((request.params as { id: string }).id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  app.delete('/api/agents/:id', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || config.worktrees.some(worktree => target.agent.workspace === worktree.identity || target.agent.workspace === worktree.hostPath) || !await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
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
  app.post('/api/agents/launch', async (request, reply) => {
    controlled(request, true);
    const before = new Set((await discovery.dashboard(config.worktrees)).agents.map(agent => agent.id));
    if (!await launch.launchHome()) return reply.code(409).send({ error: 'Could not start a new agent session.' });
    const agent = await waitForAgent(before);
    if (!agent) return reply.code(504).send({ error: 'The new session started, but Codex did not become ready within 20 seconds.' });
    return reply.code(201).send({ agentId: agent.id });
  });
  app.post('/api/agents/:id/tickets', async (request, reply) => { const s = controlled(request, true); const kind = body(request).kind; if (kind !== 'input' && kind !== 'logs' && kind !== 'terminal') return reply.code(400).send({ error: 'invalid ticket type' }); const target = await discovery.target((request.params as { id: string }).id); if (!target) return reply.code(404).send({ error: 'target unavailable' }); return { ticket: tickets.mint(s.id, kind as TicketKind, kind === 'terminal' ? target.agent.sessionId : target.agent.id).id }; });
  app.get('/ws/logs/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const id = (request.params as { id: string }).id; if (!tickets.consume(ticket, s.id, 'logs', id)) throw new Error(); const target = await discovery.target(id); if (!target) throw new Error(); let last = ''; let history = 0; let rows = 36; let cols = 120; let lastResetAt = 0; let polling = false; const poll = async (immediate = false) => { if (polling) return; polling = true; try { if (!control.active(s.id)) return socket.close(1008); const captured = await tmux.captureWindow(target.socket, target.agent.paneId, history, rows); if (captured === undefined) return socket.close(1008); if (!captured.text || captured.text === last) return; const now = Date.now(); if (!immediate && lastResetAt && now - lastResetAt < 750) return; last = captured.text; lastResetAt = now; if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'reset', text: captured.text, older: captured.older, newer: history > 0 })); } finally { polling = false; } }; const timer = setInterval(() => { if (history === 0) void poll(); }, config.pollIntervalMs); socket.on('message', (raw: unknown) => { try { const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || typeof frame?.type !== 'string') throw new Error(); if (frame.type === 'viewport') { if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300) throw new Error(); cols = frame.cols; rows = frame.rows; void (async () => { await tmux.resize(target.socket, target.agent.paneId, cols, rows); last = ''; await poll(true); })(); return; } if (frame.type === 'history') { if (!Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > 5_000) throw new Error(); history = frame.offset; last = ''; void poll(true); return; } throw new Error(); } catch { socket.close(1008); } }); socket.on('close', () => clearInterval(timer)); await poll(); } catch { socket.close(1008); } });
  app.get('/ws/input/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const id = (request.params as { id: string }).id; if (!tickets.consume(ticket, s.id, 'input', id)) throw new Error(); const target = await discovery.target(id); if (!target) throw new Error(); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || frame?.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (!decoded.length || decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); void tmux.input(target.socket, target.agent.paneId, decoded.toString('utf8')).then(ok => { if (!ok) socket.close(1011); }); } catch { socket.close(1008); } }); } catch { socket.close(1008); } });
  app.get('/ws/terminal/:id', { websocket: true }, async (socket, request) => { try { const s = controlled(request, false); const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1]; const target = await discovery.target((request.params as { id: string }).id); if (!target || !tickets.consume(ticket, s.id, 'terminal', target.agent.sessionId)) throw new Error(); const sessionName = target.agent.sessionId.slice(target.agent.socketFingerprint.length + 1); const terminal = pty.spawn(process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', target.socket.path, 'attach-session', '-t', sessionName], { name: 'xterm-256color', cols: 120, rows: 36, cwd: '/', env: safeEnv() as Record<string, string> }); terminal.onData(value => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ v: 1, type: 'output', data: Buffer.from(value).toString('base64url') }))); socket.on('message', (raw: unknown) => { try { if (!control.active(s.id)) throw new Error(); const frame = JSON.parse(String(raw)); if (frame?.v !== 1 || typeof frame?.type !== 'string') throw new Error(); if (frame.type === 'resize') { if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) || frame.cols < 2 || frame.cols > 500 || frame.rows < 2 || frame.rows > 300) throw new Error(); terminal.resize(frame.cols, frame.rows); return; } if (frame.type !== 'input' || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error(); const decoded = Buffer.from(frame.data, 'base64url'); if (decoded.length > 65_536 || decoded.toString('base64url') !== frame.data) throw new Error(); terminal.write(decoded.toString('utf8')); } catch { socket.close(1008); } }); const close = () => terminal.kill(); socket.on('close', close); terminal.onExit(() => socket.close()); } catch { socket.close(1008); } });
  return app;
}
