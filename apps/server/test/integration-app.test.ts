import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // remove every private application fixture
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('application integration surfaces', () => {
  it('registers OAuth, MCP, and authenticated Realtime status behind feature gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-integration-app-'));
    roots.push(root);
    const secret = Buffer.alloc(32, 4).toString('base64url');
    vi.stubEnv('RAC_SESSION_SECRET', secret);
    vi.stubEnv('RAC_INTEGRATION_AUTH_FILE', join(root, 'auth.json'));
    vi.stubEnv('RAC_INTEGRATION_STATE_FILE', join(root, 'policy.json'));
    vi.stubEnv('RAC_INTEGRATION_AUDIT_FILE', join(root, 'audit.jsonl'));
    vi.stubEnv('RAC_OPENAI_API_KEY', 'test-key');
    // preserve documented blank optional secrets
    vi.stubEnv('RAC_REALTIME_MCP_TOKEN', ' ');
    vi.stubEnv('RAC_INTEGRATION_FEDERATION_SECRET', ' ');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 'ek_testcredential' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const config: ValidatedConfig = {
      listen: { host: '127.0.0.1', port: 8787 },
      name: 'Remote Agents',
      publicOrigin: new URL('https://agents.example.com'),
      remoteServers: [],
      trustedProxyIps: new Set(['127.0.0.1']),
      pollIntervalMs: 500,
      newAgentCommand: 'codex',
      integrations: { enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, writeToolsEnabled: true }, multiInstance: { enabled: false } },
      projects: []
    };
    const auth = new AuthService('$argon2id$unused', secret);
    const app = await buildApp(config, { auth, reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never });
    try {
      const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { host: 'agents.example.com' } });
      expect(metadata.json().resource).toBe('https://agents.example.com/mcp');
      const signed = auth.sign({ id: 'browser-session', csrf: 'browser-csrf' });
      const status = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(status.json()).toMatchObject({ enabled: true, control: { voiceActive: false }, realtime: { enabled: true, available: true, writeToolsEnabled: true } });
      const voiceSessionId = 'voice-session-123456789';
      const realtime = await app.inject({ method: 'POST', url: '/api/realtime/session', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId } });
      expect(realtime.statusCode).toBe(200);
      const activeStatus = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(activeStatus.json()).toMatchObject({ control: { voiceActive: true } });
      const heartbeat = await app.inject({ method: 'POST', url: '/api/realtime/session/heartbeat', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId } });
      expect(heartbeat.statusCode).toBe(200);
      const stopped = await app.inject({ method: 'POST', url: '/api/realtime/session/stop', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId } });
      expect(stopped.statusCode).toBe(200);
      const stoppedStatus = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(stoppedStatus.json()).toMatchObject({ control: { voiceActive: false } });
      expect(realtime.headers['content-security-policy']).toContain('https://api.openai.com');
    } finally { await app.close(); }
  });
});
