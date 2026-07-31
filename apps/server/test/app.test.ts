import { afterEach, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
const config: ValidatedConfig = { listen:{host:'127.0.0.1',port:8787},publicOrigin:new URL('https://agents.example.com'),trustedProxyIps:new Set(['127.0.0.1']),pollIntervalMs:500,newAgentCommand:'codex',worktrees:[] };
describe('HTTP security boundary',()=>{let app:Awaited<ReturnType<typeof buildApp>>;afterEach(async()=>{await app?.close()});it('serves the browser application and its build version for the canonical host',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const response=await app.inject({method:'GET',url:'/',headers:{host:'agents.example.com'}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('text/html');expect(response.body).toContain('<!doctype html>');const version=await app.inject({method:'GET',url:'/api/ui-version',headers:{host:'agents.example.com'}});expect(version.statusCode).toBe(200);expect(version.json().version).toMatch(/^\/assets\/index-[\w-]+\.js$/)}, 15_000);it('requires canonical Host and Origin and creates a secure host cookie',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const bad=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'evil.example'}});expect(bad.statusCode).toBe(403);const boot=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'agents.example.com'}});const token=boot.json().csrfToken;const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(denied.statusCode).toBe(403);const ok=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com',origin:'https://agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(ok.statusCode).toBe(200);expect(ok.headers['set-cookie']).toContain('__Host-rac=');expect(ok.headers['set-cookie']).toContain('HttpOnly');expect(ok.headers['set-cookie']).toContain('Secure');expect(ok.headers['content-security-policy']).toContain("default-src 'self'")}, 15_000)});

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
    expect(second.response.json().active).toBe(false);
    expect(second.response.json().controllingDeviceName).toBe('Studio Mac');
    const blocked = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: second.cookie } });
    expect(blocked.statusCode).toBe(423);
    const secondHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.response.json().csrfToken };
    const unnamedSecond = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders });
    const take = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders, payload: { deviceName: 'Kitchen iPad' } });
    expect(unnamedSecond.statusCode).toBe(400);
    expect(take.json()).toMatchObject({ active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' });
    const displaced = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: first.cookie } });
    const displacedSession = await controlApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(displaced.statusCode).toBe(423);
    expect(displacedSession.json()).toMatchObject({ active: false, deviceName: 'Studio Mac', controllingDeviceName: 'Kitchen iPad' });
    await controlApp.close();
  }, 15_000);

  it('registers every authenticated client and broadcasts worktree notification dismissal', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const subscribed: unknown[] = [];
    const messages: unknown[] = [];
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const push = { enabled: true, publicKey: 'public-key', subscribe: async (subscription: unknown) => { subscribed.push(subscription); return true; }, notify: async (message: unknown) => { messages.push(message); } };
    const pushApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 6).toString('base64url')), discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never, push: push as never });
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
    const dismissal = await pushApp.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: active.cookie, 'x-csrf-token': active.response.json().csrfToken } });
    expect(registration.statusCode).toBe(204);
    expect(subscribed).toHaveLength(1);
    expect(dismissal.statusCode).toBe(204);
    expect(messages).toEqual([{ kind: 'dismiss', tag: 'worktree-status-cora', legacyTag: 'agent-status-socket:%1', worktreeId: 'cora' }]);
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

  it('waits for the requested worktree agent before responding', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = { id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '', worktreeId: 'cora' };
    let dashboards = 0;
    const discovery = { dashboard: async () => ({ generation: ++dashboards, agents: dashboards === 1 ? [] : [agent], worktrees: [] }) };
    const launch = { launch: async (id: string) => id === 'cora', launchHome: async () => true };
    const launchApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 4).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/worktrees/cora/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
    } finally { await launchApp.close(); }
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
      } as never
    });
    try {
      const boot = await swapApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await swapApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const background = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/background`, headers });
      const foreground = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/foreground`, headers });

      expect(background.statusCode).toBe(204);
      expect(foreground.statusCode).toBe(204);
      expect(suspended).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
      expect(foregrounded).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
    } finally { await swapApp.close(); }
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
    const savedPrompts = {
      list: async (key: string) => { keys.push(key); return key === 'worktree:cora' ? [...prompts] : undefined; },
      save: async (key: string, text: string) => { keys.push(key); return key === 'worktree:cora' ? { id: 'saved-prompt-002', text } : undefined; },
      consume: async (key: string, promptId: string) => { keys.push(key); return key === 'worktree:cora' ? prompts.find(prompt => prompt.id === promptId) : undefined; }
    };
    const savedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 9).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; } } as never,
      savedPrompts: savedPrompts as never
    });
    try {
      const boot = await savedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await savedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await savedApp.inject({ method: 'GET', url: '/api/agents/agent-2/saved-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await savedApp.inject({ method: 'POST', url: '/api/agents/agent-1/saved-prompts', headers, payload: { prompt: 'Summarize this branch.' } });
      const consumed = await savedApp.inject({ method: 'DELETE', url: '/api/agents/agent-1/saved-prompts/saved-prompt-001', headers });

      expect(listed.json()).toEqual({ prompts });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'saved-prompt-002', text: 'Summarize this branch.' });
      expect(consumed.json()).toEqual(prompts[0]);
      expect(keys).toEqual(['worktree:cora', 'worktree:cora', 'worktree:cora']);
    } finally {
      await savedApp.close();
    }
  }, 15_000);
});
