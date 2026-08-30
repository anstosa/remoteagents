import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const baseConfig: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [] };

// authenticate one controlling browser
const login = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
};

describe('Codex account API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // close each isolated server
  afterEach(async () => { await app?.close(); });

  it('queries safe limits and restarts only open idle worktrees after switching', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const owen = { id: 'owen', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', available: true, pinned: false, command: 'codex' };
    const firstCora = stated({ id: 'agent-cora-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: cora.path, worktreeId: cora.id, worktreeLabel: cora.label, title: 'Ready' });
    const secondCora = { ...firstCora, id: 'agent-cora-2', paneId: '%2', sessionId: 'socket:$2' };
    const workingOwen = stated({ id: 'agent-owen', paneId: '%3', sessionId: 'socket:$3', socketFingerprint: 'socket', workspace: owen.path, worktreeId: owen.id, worktreeLabel: owen.label, title: '⠋ Working' });
    const scratch = stated({ id: 'agent-scratch', paneId: '%4', sessionId: 'socket:$4', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let coraClosed = false;
    let coraResumed = false;
    const discovery = {
      // expose the replacement only after the resume handoff
      dashboard: async () => ({ generation: coraResumed ? 2 : 1, agents: [coraResumed ? secondCora : firstCora, workingOwen, scratch], worktrees: [] }),
      // resolve the original target until it closes
      target: async (id: string) => !coraClosed && id === firstCora.id ? { agent: firstCora, socket } : undefined
    };
    const accounts = {
      // return only sanitized provider data
      listAccounts: async () => [{ id: 'account-1', label: 'Personal', active: true, email: 'personal@example.com', planType: 'pro', limits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null }, rateLimitResetCredits: { availableCount: 2 } } }, { id: 'account-2', label: 'Work', active: false }],
      // switch before any worktree restart
      switchAccount: async (id: string) => { events.push(`switch:${id}`); return { id, label: 'Work', active: true }; },
      // return one refreshed post-reset snapshot
      consumeRateLimitReset: async (id: string) => ({ outcome: 'reset' as const, account: { id, label: 'Personal', active: true, limits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 }, rateLimitResetCredits: { availableCount: 1 } } } }),
      startAddAccount: async () => { throw new Error('unused'); },
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      cancelAddAccount: async () => false,
      close: async () => {}
    };
    const launch = {
      launch: async () => false,
      launchHome: async () => false,
      // expose a new agent after the selected account is active
      resume: async (id: string) => { events.push(`resume:${id}`); coraResumed = true; return true; }
    };
    app = await buildApp({ ...baseConfig, worktrees: [cora, owen] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 31).toString('base64url')),
      accounts: accounts as never,
      discovery: discovery as never,
      launch: launch as never,
      launchPollDelay: async () => {},
      queuedPrompts: { list: async () => [] } as never,
      tmux: { close: async () => { events.push(`close:${firstCora.id}`); coraClosed = true; return true; } } as never
    });
    const headers = await login(app);

    const listed = await app.inject({ method: 'GET', url: '/api/codex/accounts', headers: { host: headers.host, cookie: headers.cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ accounts: [{ id: 'account-1', label: 'Personal', active: true, email: 'personal@example.com', planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300 }, resetCount: 2 }, { id: 'account-2', label: 'Work', active: false }] });

    const reset = await app.inject({ method: 'POST', url: '/api/codex/accounts/account-1/reset', headers });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ outcome: 'reset', account: { id: 'account-1', label: 'Personal', active: true, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 }, resetCount: 1 } });

    const switched = await app.inject({ method: 'POST', url: '/api/codex/accounts/switch', headers, payload: { id: 'account-2' } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ account: { id: 'account-2', label: 'Work', active: true }, restarts: [{ worktreeId: 'cora', status: 'restarted' }, { worktreeId: 'owen', status: 'skipped', error: 'The worktree is not idle.' }] });
    expect(events).toEqual(['switch:account-2', 'close:agent-cora-1', 'resume:cora']);
  }, 15_000);

  it('starts and reports a device-code account login without exposing credentials', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    let repairTarget: string | undefined;
    const accounts = {
      listAccounts: async () => [],
      switchAccount: async () => { throw new Error('unused'); },
      startAddAccount: async (id?: string) => { repairTarget = id; return { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH' }; },
      status: async () => ({ status: 'succeeded', account: { id: 'account-3', label: 'new@example.com', email: 'new@example.com', planType: 'plus', active: false } } as const),
      cancelAddAccount: async () => true,
      close: async () => {}
    };
    app = await buildApp(baseConfig, { auth: new AuthService(hash, Buffer.alloc(32, 32).toString('base64url')), accounts: accounts as never });
    const headers = await login(app);

    const started = await app.inject({ method: 'POST', url: '/api/codex/accounts/login', headers, payload: { repairAccountId: 'account-3' } });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toEqual({ login: { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH' } });
    expect(repairTarget).toBe('account-3');
    const status = await app.inject({ method: 'GET', url: '/api/codex/accounts/login/login-1', headers: { host: headers.host, cookie: headers.cookie } });
    expect(status.json()).toEqual({ status: 'succeeded', account: { id: 'account-3', label: 'new@example.com', email: 'new@example.com', planType: 'plus', active: false } });
    const cancelled = await app.inject({ method: 'DELETE', url: '/api/codex/accounts/login/login-1', headers });
    expect(cancelled.statusCode).toBe(204);
  }, 15_000);

  it('preserves a prompt that starts while an account switch selects restart targets', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const idleCora = stated({ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: cora.path, worktreeId: cora.id, worktreeLabel: cora.label, title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let releasePaste!: () => void;
    let markPasteStarted!: () => void;
    const pasteStarted = new Promise<void>(resolve => { markPasteStarted = resolve; });
    const pasteBlocked = new Promise<void>(resolve => { releasePaste = resolve; });
    const closed: string[] = [];
    const discovery = {
      dashboard: async () => ({ generation: 1, agents: [idleCora], worktrees: [] }),
      target: async (id: string) => id === idleCora.id ? { agent: idleCora, socket } : undefined
    };
    const accounts = {
      listAccounts: async () => [],
      switchAccount: async (id: string) => ({ id, label: 'Work', active: true }),
      startAddAccount: async () => { throw new Error('unused'); },
      status: async () => ({ status: 'failed', error: 'unused' } as const),
      cancelAddAccount: async () => false,
      close: async () => {}
    };
    const tmux = {
      // hold a submitted prompt across the switch
      pastePrompt: async () => { markPasteStarted(); await pasteBlocked; return true; },
      sendKeys: async () => true,
      close: async () => { closed.push(idleCora.id); return true; }
    };
    app = await buildApp({ ...baseConfig, worktrees: [cora] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 33).toString('base64url')),
      accounts: accounts as never,
      discovery: discovery as never,
      launch: { launch: async () => false, launchHome: async () => false, resume: async () => true } as never,
      queuedPrompts: { list: async () => [] } as never,
      tmux: tmux as never
    });
    const headers = await login(app);

    const prompt = app.inject({ method: 'POST', url: `/api/agents/${idleCora.id}/prompt`, headers, payload: { prompt: 'Keep this running' } });
    await pasteStarted;
    const switched = await app.inject({ method: 'POST', url: '/api/codex/accounts/switch', headers, payload: { id: 'account-2' } });

    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ account: { id: 'account-2', label: 'Work', active: true }, restarts: [{ worktreeId: 'cora', status: 'skipped', error: 'The worktree is no longer idle.' }] });
    expect(closed).toEqual([]);
    releasePaste();
    await expect(prompt).resolves.toMatchObject({ statusCode: 204 });
  }, 15_000);
});
