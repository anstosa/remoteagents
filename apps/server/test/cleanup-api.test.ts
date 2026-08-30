import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers/config.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';

const config = testConfig();

describe('cleanup API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); });

  it('returns cleanup targets, validates selections, and exposes pending state on the dashboard', async () => {
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
      auth: await testAuthService(),
      cleanup: cleanup as never,
      discovery: discovery as never
    });
    const headers = await authenticatedHeaders(app);

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
