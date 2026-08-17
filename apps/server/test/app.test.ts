import { afterEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { AgentNotificationCoordinator } from '../src/notifications.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { SavedPromptService } from '../src/saved-prompts/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';
import type { ReviewTour } from '../src/review-tour/contracts.js';
import { PullRequestLookupError } from '../src/pull-requests/service.js';
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen:{host:'127.0.0.1',port:8787},publicOrigin:new URL('https://agents.example.com'),trustedProxyIps:new Set(['127.0.0.1']),pollIntervalMs:500,newAgentCommand:'codex',worktrees:[] };
// reset environment overrides
afterEach(() => { vi.unstubAllEnvs(); });
describe('HTTP security boundary',()=>{let app:Awaited<ReturnType<typeof buildApp>>;afterEach(async()=>{await app?.close()});it('serves the browser application and its build version for the canonical host',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const response=await app.inject({method:'GET',url:'/',headers:{host:'agents.example.com'}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('text/html');expect(response.body).toContain('<!doctype html>');const version=await app.inject({method:'GET',url:'/api/ui-version',headers:{host:'agents.example.com'}});expect(version.statusCode).toBe(200);expect(version.json().version).toMatch(/^\/assets\/index-[\w-]+\.js$/)}, 15_000);it('requires canonical Host and Origin and creates a secure host cookie',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const bad=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'evil.example'}});expect(bad.statusCode).toBe(403);const boot=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'agents.example.com'}});const token=boot.json().csrfToken;const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(denied.statusCode).toBe(403);const ok=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com',origin:'https://agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(ok.statusCode).toBe(200);expect(ok.headers['set-cookie']).toContain('__Host-rac=');expect(ok.headers['set-cookie']).toContain('HttpOnly');expect(ok.headers['set-cookie']).toContain('Secure');expect(ok.headers['content-security-policy']).toContain("default-src 'self'")}, 15_000)});

describe('server identity API', () => {
  it('publishes local and remote server choices before login and in sessions', async () => {
    const namedConfig = { ...config, name: 'X1 Carbon', icon: 'potato' as const, publicOrigin: new URL('https://x1carbon.santosa.dev'), remoteServers: [{ url: new URL('https://framework.santosa.dev') }] };
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const statusSecret = 'shared-status-secret-with-thirty-two-bytes';
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', statusSecret);
    const instanceStatusPoller = { statuses: async () => [{ url: 'https://framework.santosa.dev', name: 'Framework', icon: 'heart' as const, attention: 'idle' as const }] };
    // avoid host discovery in identity test
    const discovery = { dashboard: async () => ({ generation: 1, agents: [], worktrees: [] }) };
    const identityApp = await buildApp(namedConfig, { auth: new AuthService(hash, Buffer.alloc(32, 16).toString('base64url')), instanceStatusPoller, discovery: discovery as never });
    try {
      const bootstrap = await identityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'x1carbon.santosa.dev' } });
      const expected = { name: 'X1 Carbon', icon: 'potato', url: 'https://x1carbon.santosa.dev', remotes: [{ name: 'Framework', icon: 'heart', url: 'https://framework.santosa.dev' }] };
      expect(bootstrap.json().server).toEqual(expected);
      const login = await identityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'x1carbon.santosa.dev', origin: 'https://x1carbon.santosa.dev', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      expect(login.json().server).toEqual(expected);
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', statusSecret).update(`rac-instance-status-v1\n${namedConfig.publicOrigin.origin}\n${timestamp}`).digest('base64url');
      const published = await identityApp.inject({ method: 'GET', url: '/api/instance-status', headers: { host: 'x1carbon.santosa.dev', 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': signature } });
      expect(published.json()).toMatchObject({ name: 'X1 Carbon', icon: 'potato', attention: 'idle' });
    } finally { await identityApp.close(); }
  }, 15_000);
});

describe('server administration API', () => {
  it('renames and updates only from the controlling browser', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const renamed: string[] = [];
    const serverAdmin = {
      renameServer: async (name: string) => { renamed.push(name); return name.trim() || undefined; },
      startUpdate: async () => ({ id: 'server_update_operation_1234', kind: 'update' as const, state: 'queued' as const }),
      updateStatus: async (id: string) => id === 'server_update_operation_1234' ? ({ id, kind: 'update' as const, state: 'running' as const }) : undefined,
      // expose fetched upstream state
      updateAvailable: async () => true
    };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const rename = await adminApp.inject({ method: 'PATCH', url: '/api/server/name', headers, payload: { name: 'Garage Server' } });
      const update = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers });
      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_operation_1234', headers: { host: headers.host, cookie: headers.cookie } });
      const availability = await adminApp.inject({ method: 'GET', url: '/api/server/update-available', headers: { host: headers.host, cookie: headers.cookie } });

      expect(rename.json()).toMatchObject({ name: 'Garage Server', server: { name: 'Garage Server' } });
      expect(renamed).toEqual(['Garage Server']);
      expect(update.statusCode).toBe(202);
      expect(update.json()).toMatchObject({ state: 'queued' });
      expect(status.json()).toMatchObject({ state: 'running' });
      expect(availability.json()).toEqual({ available: true });
    } finally {
      await adminApp.close();
    }
  }, 15_000);
});

describe('project browser security boundary', () => {
  it('limits iframe sources to configured project origins', async () => {
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex', projectUrl: 'https://project.example.com' };
    const app = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host: 'agents.example.com' } });
      expect(response.headers['content-security-policy']).toContain("frame-src 'self' https://project.example.com");
      expect(response.headers['content-security-policy']).not.toContain('evil.example.com');
    } finally { await app.close(); }
  });
});

describe('client control', () => {
  it('automatically activates the first client and lets another client take control', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const names = new Map<string, string>();
    const devices = {
      get: async (sessionId: string) => names.get(sessionId),
      set: async (sessionId: string, name: string) => {
        const normalized = name.trim();
        if (!normalized) return undefined;
        names.set(sessionId, normalized);
        return normalized;
      }
    };
    const controlApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 5).toString('base64url')), devices: devices as never });
    const login = async () => {
      const boot = await controlApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await controlApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const first = await login();
    const firstHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie, 'x-csrf-token': first.response.json().csrfToken };
    const unnamedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders });
    const namedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders, payload: { deviceName: 'Studio Mac' } });
    const second = await login();
    expect(first.response.json().active).toBe(true);
    expect(first.response.json().deviceName).toBeUndefined();
    expect(unnamedFirst.statusCode).toBe(400);
    expect(namedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Mac', controllingDeviceName: 'Studio Mac' });
    const invalidRename = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: '   ' } });
    const renamedFirst = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: 'Studio Display' } });
    expect(invalidRename.statusCode).toBe(400);
    expect(renamedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Display', controllingDeviceName: 'Studio Display' });
    const dashboardTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: firstHeaders });
    expect(dashboardTicket.statusCode).toBe(200);
    expect(dashboardTicket.json().ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(second.response.json().active).toBe(false);
    expect(second.response.json().controllingDeviceName).toBe('Studio Mac');
    const secondHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.response.json().csrfToken };
    const blocked = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: second.cookie } });
    const blockedTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: secondHeaders });
    expect(blocked.statusCode).toBe(423);
    expect(blockedTicket.statusCode).toBe(423);
    const unnamedSecond = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders });
    const take = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders, payload: { deviceName: 'Kitchen iPad' } });
    expect(unnamedSecond.statusCode).toBe(400);
    expect(take.json()).toMatchObject({ active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' });
    const displaced = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: first.cookie } });
    const displacedSession = await controlApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(displaced.statusCode).toBe(423);
    expect(displacedSession.json()).toMatchObject({ active: false, deviceName: 'Studio Display', controllingDeviceName: 'Kitchen iPad' });
    await controlApp.close();
  }, 15_000);

  it('registers every authenticated client without pushing silent notification dismissals', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const subscribed: unknown[] = [];
    const messages: unknown[] = [];
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const push = { enabled: true, publicKey: 'public-key', subscribe: async (subscription: unknown) => { subscribed.push(subscription); return true; }, notify: async (message: unknown) => { messages.push(message); } };
    const notifications = new AgentNotificationCoordinator(() => {}, 0);
    notifications.observe({ ...agent, title: '⠋ Working' });
    notifications.observe(agent);
    await new Promise(resolve => setTimeout(resolve, 0));
    const discovery = { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pushApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 6).toString('base64url')), discovery: discovery as never, push: push as never, notifications });
    const login = async () => {
      const boot = await pushApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await pushApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const active = await login();
    const inactive = await login();
    expect(inactive.response.json().active).toBe(false);
    const key = await pushApp.inject({ method: 'GET', url: '/api/push/public-key', headers: { host: 'agents.example.com', cookie: inactive.cookie } });
    expect(key.json()).toEqual({ publicKey: 'public-key' });
    const registration = await pushApp.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: inactive.cookie, 'x-csrf-token': inactive.response.json().csrfToken }, payload: { endpoint: 'https://push.example.com/subscription', keys: { p256dh: 'key', auth: 'auth' } } });
    const unreadDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    const dismissal = await pushApp.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: active.cookie, 'x-csrf-token': active.response.json().csrfToken } });
    const viewedDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    expect(registration.statusCode).toBe(204);
    expect(subscribed).toHaveLength(1);
    expect(unreadDashboard.json().agents[0].unread).toBe(true);
    expect(dismissal.statusCode).toBe(204);
    expect(viewedDashboard.json().agents[0].unread).toBe(false);
    expect(messages).toEqual([]);
    notifications.stop();
    await pushApp.close();
  }, 15_000);
});

describe('agent launches', () => {
  it('waits for a discovered Codex pane and returns its id to the client', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = { id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu', title: '' };
    let dashboards = 0;
    const discovery = { dashboard: async () => ({ generation: ++dashboards, agents: dashboards === 1 ? [] : [agent], worktrees: [] }) };
    const launch = { launch: async () => true, launchHome: async () => true };
    const launchApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 3).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/agents/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
    } finally { await launchApp.close(); }
  }, 15_000);

  it('waits beyond twenty seconds for the requested worktree agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '', worktreeId: 'cora' };
    let dashboards = 0;
    // reveal after the old timeout
    const discovery = { dashboard: async () => ({ generation: ++dashboards, agents: dashboards < 83 ? [] : [agent], worktrees: [] }) };
    const launch = { launch: async (id: string) => id === 'cora', launchHome: async () => true };
    // skip real poll delays
    const skipLaunchPollDelay = async () => {};
    const launchApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 4).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: skipLaunchPollDelay });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/worktrees/cora/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
      expect(dashboards).toBe(83);
    } finally { await launchApp.close(); }
  }, 15_000);
});

describe('pull request switch API', () => {
  // preserve lookup failures across the HTTP boundary
  it('returns an actionable gateway error when GitHub lookup fails', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const prSwitch = { available: async () => { throw new PullRequestLookupError('GitHub could not load pull requests (503).'); } };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 17).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await pullRequestApp.inject({ method: 'GET', url: '/api/agents/agent-1/switch-prs', headers: { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] } });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'GitHub could not load pull requests (503).' });
    } finally { await pullRequestApp.close(); }
  }, 15_000);
});

describe('configured worktree deactivation', () => {
  it('closes an idle configured agent so its worktree becomes inactive', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' };
    let closed = false;
    const deactivateApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 7).toString('base64url')), discovery: { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined } as never, tmux: { close: async () => { closed = true; return true; } } as never });
    try {
      const boot = await deactivateApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await deactivateApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await deactivateApp.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(204);
      expect(closed).toBe(true);
    } finally { await deactivateApp.close(); }
  }, 15_000);

  it('sleeps an idle agent and wakes it through the resume alias', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let active = true;
    let resumed = '';
    const discovery = {
      // expose the current process state
      dashboard: async () => active
        ? { generation: 1, agents: [agent], worktrees: [] }
        : { generation: 2, agents: [], worktrees: [{ id: worktree.id, label: worktree.label, path: worktree.path, available: true, pinned: false, order: 0 }] },
      // resolve only the live agent
      target: async (id: string) => active && id === agent.id ? { agent, socket } : undefined
    };
    const launch = {
      // wake through the requested alias
      resume: async (id: string) => { resumed = id; active = true; return true; },
      launch: async () => false,
      launchHome: async () => false
    };
    const sleepApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { active = false; return true; } } as never, launchPollDelay: async () => {} });
    try {
      const boot = await sleepApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await sleepApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const slept = await sleepApp.inject({ method: 'POST', url: '/api/agents/agent-1/sleep', headers });
      expect(slept.statusCode).toBe(204);
      const sleepingDashboard = await sleepApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(sleepingDashboard.json().worktrees).toEqual([expect.objectContaining({ id: 'cora', sleeping: true })]);

      const woke = await sleepApp.inject({ method: 'POST', url: '/api/worktrees/cora/wake', headers });
      expect(woke.statusCode).toBe(201);
      expect(woke.json()).toEqual({ agentId: agent.id });
      expect(resumed).toBe('cora');
    } finally { await sleepApp.close(); }
  }, 15_000);
});

describe('agent terminal swap', () => {
  it('backgrounds the agent for terminal mode and foregrounds it when returning', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const suspended: Array<{ pane: string; path: string }> = [];
    const foregrounded: Array<{ pane: string; path: string }> = [];
    const swapApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 8).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      tmux: {
        suspend: async (targetSocket: typeof socket, pane: string) => { suspended.push({ pane, path: targetSocket.path }); return true; },
        foreground: async (targetSocket: typeof socket, pane: string) => { foregrounded.push({ pane, path: targetSocket.path }); return true; }
      } as never,
      prSwitch: { actionsUrl: async (id: string) => id === agent.id ? 'https://github.com/octo/repo/actions' : undefined } as never
    });
    try {
      const boot = await swapApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await swapApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const background = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/background`, headers });
      const foreground = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/foreground`, headers });
      const actions = await swapApp.inject({ method: 'GET', url: `/api/agents/${agent.id}/github-actions`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(background.statusCode).toBe(204);
      expect(foreground.statusCode).toBe(204);
      expect(actions.json()).toEqual({ url: 'https://github.com/octo/repo/actions' });
      expect(suspended).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
      expect(foregrounded).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
    } finally { await swapApp.close(); }
  }, 15_000);
});

describe('guided review API boundary', () => {
  it('normalizes malformed and oversized requests while accepting the exact request shape', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const snapshot = { agentId: 'agent-1', worktreeId: 'cora', workspace: '/worktrees/cora', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'empty-fingerprint', changes: [] };
    const reviewTours = {
      capability: async () => ({ available: true }),
      prepare: async () => ({ snapshot, resolved: {} }),
      fingerprint: async () => ({ snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false }, empty: true })
    };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const pasted: string[] = [];
    const reviewApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')),
      reviewTours: reviewTours as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      tmux: { pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt); return true; }, queue: async () => true } as never
    });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken, 'content-type': 'application/json' };
      const malformed = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: '{"scope":' });
      const oversized = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, padding: 'x'.repeat(1_100) }) });
      const unexpected = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, unexpected: true }) });
      const valid = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const invalidFingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=maybe&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const fingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=false&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const maximumPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_000), attachments: [] }) });
      const oversizedPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_001), attachments: [] }) });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(unexpected.statusCode).toBe(400);
      expect(unexpected.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ status: 'empty', snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(invalidFingerprint.statusCode).toBe(400);
      expect(invalidFingerprint.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(fingerprint.statusCode).toBe(200);
      expect(fingerprint.json()).toEqual({ status: 'empty', snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(maximumPrompt.statusCode).toBe(204);
      expect(oversizedPrompt.statusCode).toBe(400);
      expect(pasted).toHaveLength(1);
    } finally { await reviewApp.close(); }
  }, 15_000);

  it('serves and dismisses a branch-bound review from durable dashboard state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const review: ReviewTour = { title: 'Persisted tour', overview: 'Resume the saved walkthrough.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'persisted-fingerprint-1234', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
    const reviewStore = new ReviewTourStore(join(directory, 'reviews.json'));
    await reviewStore.save('cora', 'feature/review', review);
    const discovery = { dashboard: async () => ({ generation: 1, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, order: 0, branch: 'feature/review' }] }) };
    const reviewApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), discovery: discovery as never, reviewStore, reviewTours: { capability: async () => ({ available: true }) } as never });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const mutationHeaders = { ...headers, origin: 'https://agents.example.com', 'x-csrf-token': login.json().csrfToken };
      const dashboard = await reviewApp.inject({ method: 'GET', url: '/api/dashboard', headers });
      const restored = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      const dismissed = await reviewApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/review-tour', headers: mutationHeaders });
      const missing = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      expect(dashboard.json().reviews).toEqual([expect.objectContaining({ worktreeId: 'cora', branch: 'feature/review', title: review.title })]);
      expect(restored.json()).toMatchObject({ status: 'ready', review: { worktreeId: 'cora', branch: 'feature/review', tour: { fingerprint: review.fingerprint } } });
      expect(dismissed.statusCode).toBe(204);
      expect(missing.statusCode).toBe(404);
    } finally { await reviewApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('queued prompt API', () => {
  it('lists, reorders, edits, and cancels prompts waiting behind a busy agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 11).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'First prompt', attachments: [] } });
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Second prompt', attachments: [] } });

      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [first, second] = listed.json().prompts as Array<{ id: string; text: string }>;
      const moved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${second!.id}/move`, headers, payload: { direction: 'earlier' } });
      const edited = await queuedApp.inject({ method: 'PUT', url: `/api/agents/agent-1/queued-prompts/${second!.id}`, headers, payload: { prompt: 'Edited second prompt' } });
      const cancelled = await queuedApp.inject({ method: 'DELETE', url: `/api/agents/agent-1/queued-prompts/${first!.id}`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.statusCode).toBe(200);
      expect([first?.text, second?.text]).toEqual(['First prompt', 'Second prompt']);
      expect(moved.json().prompts.map((prompt: { id: string }) => prompt.id)).toEqual([second!.id, first!.id]);
      expect(edited.json()).toMatchObject({ id: second!.id, text: 'Edited second prompt' });
      expect(cancelled.statusCode).toBe(204);
      expect(remaining.json().prompts).toMatchObject([{ id: second!.id, text: 'Edited second prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('moves a queued prompt and its attachments into saved prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 12).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      savedPrompts: new SavedPromptService(join(directory, 'saved.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Save this prompt', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const savedPrompts = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/saved-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ text: 'Save this prompt', attachments: [{ name: 'context.txt', size: 7 }] });
      expect(remaining.json()).toEqual({ prompts: [] });
      expect(savedPrompts.json()).toMatchObject({ prompts: [{ text: 'Save this prompt', attachments: [{ name: 'context.txt', size: 7 }] }] });
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('saved prompt API', () => {
  it('keeps prompts with a configured worktree when its agent pane changes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agents = [
      { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' },
      { id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' }
    ];
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const prompts = [{ id: 'saved-prompt-001', text: 'Review this change.' }];
    const keys: string[] = [];
    const queued: string[] = [];
    const savedPrompts = {
      list: async (key: string) => { keys.push(key); return key === 'worktree:cora' ? [...prompts] : undefined; },
      save: async (key: string, text: string, attachments: Array<{ name: string; data: string }>) => { keys.push(key); return key === 'worktree:cora' ? { id: 'saved-prompt-002', text, attachments: attachments.map(attachment => ({ name: attachment.name, size: Buffer.from(attachment.data, 'base64').length })) } : undefined; },
      get: async (key: string, promptId: string) => { keys.push(key); return key === 'worktree:cora' ? prompts.find(prompt => prompt.id === promptId) : undefined; },
      consumeOnSuccess: async (key: string, promptId: string, use: (prompt: { id: string; text: string }) => Promise<boolean>) => { keys.push(key); const prompt = key === 'worktree:cora' ? prompts.find(candidate => candidate.id === promptId) : undefined; return prompt === undefined ? 'missing' : await use(prompt) ? 'consumed' : 'failed'; },
      consume: async (key: string, promptId: string) => { keys.push(key); return key === 'worktree:cora' ? prompts.find(prompt => prompt.id === promptId) : undefined; }
    };
    const savedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 9).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; } } as never,
      tmux: { pastePrompt: async (_socket: unknown, _paneId: string, _buffer: string, prompt: string) => { queued.push(prompt); return true; }, queue: async () => true } as never,
      savedPrompts: savedPrompts as never
    });
    try {
      const boot = await savedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await savedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await savedApp.inject({ method: 'GET', url: '/api/agents/agent-2/saved-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await savedApp.inject({ method: 'POST', url: '/api/agents/agent-1/saved-prompts', headers, payload: { prompt: 'Summarize this branch.', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      const queuedSaved = await savedApp.inject({ method: 'POST', url: '/api/agents/agent-2/saved-prompts/saved-prompt-001/queue', headers });
      const consumed = await savedApp.inject({ method: 'DELETE', url: '/api/agents/agent-1/saved-prompts/saved-prompt-001', headers });

      expect(listed.json()).toEqual({ prompts });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'saved-prompt-002', text: 'Summarize this branch.', attachments: [{ name: 'context.txt', size: 7 }] });
      expect(queuedSaved.statusCode).toBe(204);
      expect(queued).toEqual(['Review this change. ']);
      expect(consumed.json()).toEqual(prompts[0]);
      expect(keys).toEqual(['worktree:cora', 'worktree:cora', 'worktree:cora', 'worktree:cora']);
    } finally {
      await savedApp.close();
    }
  }, 15_000);
});

describe('prompt history API', () => {
  it('records and lists history by configured worktree when the agent pane changes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agents = [
      { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' },
      { id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' }
    ];
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const stored: Array<{ id: string; text: string; createdAt: string }> = [];
    const keys: string[] = [];
    const promptHistory = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      record: async (key: string, text: string) => {
        keys.push(`record:${key}`);
        const entry = { id: 'prompt-history-001', text, createdAt: '2026-08-04T01:00:00.000Z' };
        stored.unshift(entry);
        return entry;
      }
    };
    const historyApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; } } as never,
      tmux: { pastePrompt: async () => true, queue: async () => true } as never,
      promptHistory: promptHistory as never
    });
    try {
      const boot = await historyApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await historyApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const queued = await historyApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Review this branch.' } });
      const listed = await historyApp.inject({ method: 'GET', url: '/api/agents/agent-2/prompt-history', headers: { host: headers.host, cookie: headers.cookie } });

      expect(queued.statusCode).toBe(204);
      expect(listed.json()).toEqual({ prompts: stored });
      expect(keys).toEqual(['record:worktree:cora', 'list:worktree:cora']);
    } finally {
      await historyApp.close();
    }
  }, 15_000);
});

describe('worktree notes API', () => {
  it('lists, creates, updates, and deletes notes for the configured worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const stored: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-001', text: 'Existing note' }];
    const keys: string[] = [];
    const notes = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      create: async (key: string, title?: string) => { keys.push(`create:${key}:${title ?? ''}`); const note = { id: 'note-identifier-002', text: '', ...(title === undefined ? {} : { title }) }; stored.unshift(note); return note; },
      update: async (key: string, noteId: string, text: string) => { keys.push(`update:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.text = text; return { ...note }; },
      rename: async (key: string, noteId: string, title: string) => { keys.push(`rename:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.title = title; return { ...note }; },
      delete: async (key: string, noteId: string) => { keys.push(`delete:${key}:${noteId}`); const index = stored.findIndex(candidate => candidate.id === noteId); return index < 0 ? undefined : stored.splice(index, 1)[0]; }
    };
    const notesApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')), notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await notesApp.inject({ method: 'GET', url: '/api/worktrees/cora/notes', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { title: 'Assistant response' } });
      const updated = await notesApp.inject({ method: 'PUT', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { text: 'Autosaved note' } });
      const renamed = await notesApp.inject({ method: 'PATCH', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { title: 'Release checklist' } });
      const deleted = await notesApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/notes/note-identifier-001', headers });
      const missing = await notesApp.inject({ method: 'GET', url: '/api/worktrees/missing/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({ notes: [{ id: 'note-identifier-001', text: 'Existing note' }] });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'note-identifier-002', text: '', title: 'Assistant response' });
      expect(updated.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Assistant response' });
      expect(renamed.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Release checklist' });
      expect(deleted.json()).toEqual({ id: 'note-identifier-001', text: 'Existing note' });
      expect(missing.statusCode).toBe(404);
      expect(keys).toEqual(['list:cora', 'create:cora:Assistant response', 'update:cora:note-identifier-002', 'rename:cora:note-identifier-002', 'delete:cora:note-identifier-001']);
    } finally { await notesApp.close(); }
  }, 15_000);
});

describe('workspace files API', () => {
  it('lists response files and previews active or inactive workspace files', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', title: 'Ready' };
    const discovery = { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined };
    const workspaceFiles = {
      list: async (workspace: string, message: string) => workspace === '/worktrees/cora' && message === 'Changed `src/main.ts`.' ? [{ path: 'src/main.ts', size: 12 }] : [],
      preview: async (workspace: string, path: string) => workspace === '/worktrees/cora' && path === 'src/main.ts' ? { path, size: 12, binary: false, truncated: false, content: 'const ok=1;\n' } : undefined
    };
    const filesApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 15).toString('base64url')), discovery: discovery as never, workspaceFiles: workspaceFiles as never });
    try {
      const boot = await filesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await filesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const listed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/message-files', headers, payload: { message: 'Changed `src/main.ts`.' } });
      const previewed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: 'src/main.ts' } });
      const worktreePreviewed = await filesApp.inject({ method: 'POST', url: '/api/worktrees/cora/file-preview', headers, payload: { path: 'src/main.ts' } });
      const invalid = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: '' } });
      const missingWorktree = await filesApp.inject({ method: 'POST', url: '/api/worktrees/missing/file-preview', headers, payload: { path: 'src/main.ts' } });

      expect(listed.json()).toEqual({ files: [{ path: 'src/main.ts', size: 12 }] });
      expect(previewed.json()).toEqual({ path: 'src/main.ts', size: 12, binary: false, truncated: false, content: 'const ok=1;\n' });
      expect(worktreePreviewed.json()).toEqual(previewed.json());
      expect(invalid.statusCode).toBe(400);
      expect(missingWorktree.statusCode).toBe(404);
    } finally { await filesApp.close(); }
  }, 15_000);
});
