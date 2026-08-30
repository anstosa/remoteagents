import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { AuthService } from '../../src/auth/service.js';

export const testPassword = 'synthetic-password';
export const testHost = 'agents.example.com';
export const testOrigin = 'https://agents.example.com';

/**
 * An AuthService that accepts {@link testPassword}. Pass it as `deps.auth` to
 * `buildApp`, then log in with {@link authenticatedHeaders}. `secretByte` only
 * matters when two apps must have distinct session secrets in one test.
 */
export async function testAuthService(secretByte = 1): Promise<AuthService> {
  const passwordHash = await argon2.hash(testPassword, { type: argon2.argon2id });
  return new AuthService(passwordHash, Buffer.alloc(32, secretByte).toString('base64url'));
}

/**
 * The bootstrap → login dance, returning the full header set (host, origin,
 * cookie, csrf token) for a controlling browser. GET requests only need
 * `{ host, cookie }`; mutating requests need the whole set.
 */
export async function authenticatedHeaders(app: FastifyInstance): Promise<{ host: string; origin: string; cookie: string; 'x-csrf-token': string }> {
  const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: testHost } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: testHost, origin: testOrigin, 'x-csrf-token': bootstrap.json().csrfToken },
    payload: { password: testPassword },
  });
  return {
    host: testHost,
    origin: testOrigin,
    cookie: String(login.headers['set-cookie']).split(';')[0],
    'x-csrf-token': login.json().csrfToken,
  };
}
