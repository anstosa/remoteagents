import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
export type Session = { id: string; csrf: string; expires: number };
const token = () => randomBytes(32).toString('base64url');
export class AuthService {
  private sessions = new Map<string, Session>(); private preauth = new Map<string, number>();
  constructor(private readonly passwordHash: string, private readonly secret: string, private readonly now: () => number = Date.now) {
    if (!passwordHash.startsWith('$argon2id$')) throw new Error('RAC_PASSWORD_HASH must be an Argon2id hash');
    if (Buffer.from(secret, 'base64url').length < 32) throw new Error('RAC_SESSION_SECRET must contain at least 32 bytes');
  }
  bootstrap(): string { const value = token(); this.preauth.set(value, this.now() + 300_000); return value; }
  async login(password: string, preauth: string): Promise<Session | undefined> { const expiry = this.preauth.get(preauth); this.preauth.delete(preauth); if (!expiry || expiry < this.now()) return undefined; const ok = await argon2.verify(this.passwordHash, password).catch(() => false); if (!ok) return undefined; const session = { id: token(), csrf: token(), expires: this.now() + 8 * 60 * 60_000 }; this.sessions.set(session.id, session); return session; }
  get(id: string | undefined): Session | undefined { if (!id) return undefined; const session = this.sessions.get(id); if (!session || session.expires < this.now()) { this.sessions.delete(id); return undefined; } return session; }
  logout(id?: string): void { if (id) this.sessions.delete(id); }
  sign(id: string): string { const mac = createHmac('sha256', this.secret).update(id).digest('base64url'); return `${id}.${mac}`; }
  unsign(value?: string): string | undefined { if (!value) return undefined; const [id, mac, ...extra] = value.split('.'); if (!id || !mac || extra.length) return undefined; const expected = createHmac('sha256', this.secret).update(id).digest('base64url'); if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined; return id; }
  csrf(session: Session, candidate?: string): boolean { return !!candidate && candidate.length === session.csrf.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(session.csrf)); }
}
