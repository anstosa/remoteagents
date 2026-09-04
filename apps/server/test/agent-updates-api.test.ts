import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AgentUpdateServiceLike } from '../src/agent-updates/service.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

describe('agent update API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  // close each isolated HTTP server
  afterEach(async () => { await app?.close(); });

  it('publishes versions and executes authenticated configured updates', async () => {
    const available = { kind: 'codex' as const, currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true };
    const current = { kind: 'codex' as const, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false };
    const statuses = vi.fn(async () => [available]);
    const update = vi.fn(async () => ({ outcome: 'updated' as const, status: current }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses, update } satisfies AgentUpdateServiceLike });
    const denied = await app.inject({ method: 'GET', url: '/api/agents/updates', headers: { host: testHost } });
    const headers = await authenticatedHeaders(app);
    const listed = await app.inject({ method: 'GET', url: '/api/agents/updates', headers: { host: headers.host, cookie: headers.cookie } });
    const updated = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    expect(denied.statusCode).toBe(401);
    expect(listed.json()).toEqual({ agents: [available] });
    expect(updated.json()).toEqual({ agent: current });
    expect(update).toHaveBeenCalledWith('codex');
  }, 15_000);

  it('maps unavailable, busy, and failed updates', async () => {
    const update: AgentUpdateServiceLike['update'] = vi.fn(async kind => {
      // exercise every public service refusal
      if (kind === 'codex') return { outcome: 'busy' };
      if (kind === 'claude') return { outcome: 'failed' };
      return { outcome: 'unavailable' };
    });
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update } });
    const headers = await authenticatedHeaders(app);
    const busy = await app.inject({ method: 'POST', url: '/api/agents/codex/update', headers });
    const failed = await app.inject({ method: 'POST', url: '/api/agents/claude/update', headers });
    const unavailable = await app.inject({ method: 'POST', url: '/api/agents/omx/update', headers });
    expect(busy.statusCode).toBe(409);
    expect(failed.statusCode).toBe(502);
    expect(unavailable.statusCode).toBe(404);
  }, 15_000);

  it('rejects unknown agent kinds', async () => {
    const update: AgentUpdateServiceLike['update'] = vi.fn(async () => ({ outcome: 'unavailable' }));
    app = await buildApp(testConfig(), { auth: await testAuthService(), agentUpdates: { statuses: async () => [], update } });
    const headers = await authenticatedHeaders(app);
    const unknown = await app.inject({ method: 'POST', url: '/api/agents/not-real/update', headers });
    expect(unknown.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  }, 15_000);
});
