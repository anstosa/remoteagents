import { afterEach, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = { listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [] };

describe('cleanup API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); });

  it('returns cleanup targets, validates selections, and exposes pending state on the dashboard', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const target = { id: 'cleanup-abcdefghijklmnopqrstuvwx', kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old agent' };
    let pending = [target];
    const cleanup = {
      pending: () => pending,
      scan: async () => pending,
      cleanup: async (ids: unknown) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !pending.some(target => target.id === id))) return undefined;
        pending = pending.filter(target => !ids.includes(target.id));
        return pending;
      }
    };
    const discovery = { dashboard: async () => ({ generation: 1, agents: [], worktrees: [] }) };
    app = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 12).toString('base64url')),
      cleanup: cleanup as never,
      discovery: discovery as never
    });
    const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
    const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

    const listed = await app.inject({ method: 'GET', url: '/api/cleanup', headers: { host: headers.host, cookie: headers.cookie } });
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
    const invalid = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: ['missing'] } });
    const cleaned = await app.inject({ method: 'POST', url: '/api/cleanup', headers, payload: { targetIds: [target.id] } });
    const after = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ targets: [target] });
    expect(dashboard.json().cleanupPending).toBe(1);
    expect(invalid.statusCode).toBe(400);
    expect(cleaned.json()).toEqual({ targets: [] });
    expect(after.json().cleanupPending).toBe(0);
  }, 15_000);
});
