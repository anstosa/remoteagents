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
    const controlApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 5).toString('base64url')) });
    const login = async () => {
      const boot = await controlApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await controlApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const first = await login();
    const second = await login();
    expect(first.response.json().active).toBe(true);
    expect(second.response.json().active).toBe(false);
    const blocked = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: second.cookie } });
    expect(blocked.statusCode).toBe(423);
    const take = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.response.json().csrfToken } });
    expect(take.json()).toEqual({ active: true });
    const displaced = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(displaced.statusCode).toBe(423);
    await controlApp.close();
  }, 15_000);

  it('allows every authenticated client to register for push notifications', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const subscribed: unknown[] = [];
    const push = { enabled: true, publicKey: 'public-key', subscribe: async (subscription: unknown) => { subscribed.push(subscription); return true; } };
    const pushApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 6).toString('base64url')), push: push as never });
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
    expect(registration.statusCode).toBe(204);
    expect(subscribed).toHaveLength(1);
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
