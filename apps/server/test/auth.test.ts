import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { AuthService } from '../src/auth/service.js';
describe('AuthService',()=>{it('only creates an authenticated session after one-time bootstrap',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});const auth=new AuthService(hash,Buffer.alloc(32,7).toString('base64url'));const csrf=auth.bootstrap();expect(await auth.login('wrong',csrf)).toBeUndefined();const token=auth.bootstrap();const session=await auth.login('synthetic-password',token);expect(session?.csrf).toHaveLength(43);const signed=auth.sign(session!.id);expect(auth.get(auth.unsign(signed))?.id).toBe(session!.id);expect(auth.csrf(session!,'bad')).toBe(false)}, 15_000)});
