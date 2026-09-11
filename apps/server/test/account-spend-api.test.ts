import argon2 from 'argon2';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, adapters: {}, projects: [] };
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

// close isolated authenticated servers
afterEach(async () => { await app?.close(); });

// allow real authentication hashing while checking the public billing boundary
it('returns only safe per-key totals and skips billing for chatgpt accounts', async () => {
  const queried: string[] = [];
  const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
  app = await buildApp(config, {
    auth: new AuthService(hash, Buffer.alloc(32, 45).toString('base64url')),
    accounts: {
      // supply one account of each billing state
      listAccounts: async () => [
        { id: 'personal', label: 'Personal', active: true },
        { id: 'billed', label: 'Production', authMode: 'apikey', active: false },
        { id: 'missing', label: 'Unconfigured', authMode: 'apikey', active: false },
        { id: 'failed', label: 'Unavailable', authMode: 'apikey', active: false }
      ],
      // close the fixture without provider work
      close: async () => {}
    } as never,
    accountSpend: {
      // include private extra fields to exercise the response allowlist
      read: async (id: string) => {
        queried.push(id);
        // expose one successful provider result
        if (id === 'billed') return { status: 'available', todayUsd: 1.23456, weekUsd: 9.87654, asOf: 1_789_142_400, adminKey: 'synthetic-admin-secret', apiKeyId: 'key_private' };
        return { status: id === 'missing' ? 'unconfigured' : 'unavailable', error: 'synthetic-admin-secret' };
      }
    } as never
  });
  const anonymous = await app.inject({ method: 'GET', url: '/api/codex/accounts', headers: { host: 'agents.example.com' } });
  expect(anonymous.statusCode).toBe(401);
  expect(queried).toEqual([]);
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const result = await app.inject({ method: 'GET', url: '/api/codex/accounts', headers: { host: 'agents.example.com', cookie } });
  expect(result.statusCode).toBe(200);
  expect(queried).toEqual(['billed', 'missing', 'failed']);
  expect(result.json()).toEqual({ accounts: [
    { id: 'personal', label: 'Personal', active: true },
    { id: 'billed', label: 'Production', authMode: 'apikey', active: false, spend: { status: 'available', todayUsd: 1.23456, weekUsd: 9.87654, asOf: 1_789_142_400 } },
    { id: 'missing', label: 'Unconfigured', authMode: 'apikey', active: false, spend: { status: 'unconfigured' } },
    { id: 'failed', label: 'Unavailable', authMode: 'apikey', active: false, spend: { status: 'unavailable' } }
  ] });
  expect(result.body).not.toContain('synthetic-admin-secret');
  expect(result.body).not.toContain('key_private');
}, 15_000);
