import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { validateConfig } from '../src/config/schema.js';

describe('minimal onboarding', () => {
  it('accepts an omitted worktree list for scratch-only loopback use', async () => {
    const config = await validateConfig({ publicOrigin: 'http://127.0.0.1:8787' });

    expect(config.worktrees).toEqual([]);
    expect(config.publicOrigin.origin).toBe('http://127.0.0.1:8787');
    await expect(validateConfig({ publicOrigin: 'http://agents.example.com' })).rejects.toThrow('loopback HTTP');
  });

  it('uses a non-secure local cookie only for the loopback HTTP origin', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const config = await validateConfig({ publicOrigin: 'http://127.0.0.1:8787' });
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 28).toString('base64url')) });
    try {
      const browser = { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' };
      const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: browser.host } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...browser, 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });

      expect(login.statusCode).toBe(200);
      expect(login.headers['set-cookie']).toContain('rac-local=');
      expect(login.headers['set-cookie']).not.toContain('Secure');
      expect(login.headers['strict-transport-security']).toBeUndefined();
      expect(login.headers['content-security-policy']).toContain('ws://127.0.0.1:8787');
    } finally {
      await app.close();
    }
  }, 15_000);
});
