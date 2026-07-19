import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { AuthService } from '../src/auth/service.js';

describe('AuthService', () => {
  it('only creates an authenticated session after one-time bootstrap and restores signed sessions after a restart', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const secret = Buffer.alloc(32, 7).toString('base64url');
    const auth = new AuthService(hash, secret);
    const csrf = auth.bootstrap();
    expect(await auth.login('wrong', csrf)).toBeUndefined();

    const token = auth.bootstrap();
    const session = await auth.login('synthetic-password', token);
    expect(session?.csrf).toHaveLength(43);
    const signed = auth.sign(session!);
    expect(auth.get(auth.unsign(signed))?.id).toBe(session!.id);

    const restarted = new AuthService(hash, secret);
    expect(restarted.get(restarted.unsign(signed))).toEqual(session);
    expect(auth.csrf(session!, 'bad')).toBe(false);
  }, 15_000);
});
