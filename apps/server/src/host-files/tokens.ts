import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isHostFileIdentity, isHostFilesPath, type HostFileIdentity } from './contracts.js';

export type HostFileTokenPurpose = 'object'|'destination-directory';
export type HostFileTokenPayload = {
  version: 1;
  purpose: HostFileTokenPurpose;
  sessionId: string;
  placeId: string;
  backendGeneration: string;
  path: string;
  identity: HostFileIdentity;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

const maxTokenBytes = 16_384;

// validate one decoded capability payload
function isPayload(value: unknown): value is HostFileTokenPayload {
  // require one plain payload object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.version === 1 && (payload.purpose === 'object' || payload.purpose === 'destination-directory')
    && typeof payload.sessionId === 'string' && payload.sessionId.length >= 1 && payload.sessionId.length <= 512
    && typeof payload.placeId === 'string' && payload.placeId.length >= 1 && payload.placeId.length <= 4096
    && typeof payload.backendGeneration === 'string' && payload.backendGeneration.length >= 1 && payload.backendGeneration.length <= 512
    && isHostFilesPath(payload.path) && isHostFileIdentity(payload.identity)
    && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
    && typeof payload.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(payload.nonce);
}

export class HostFilesTokenService {
  // retain a private signer and bounded token lifetime
  constructor(private readonly secret: string, private readonly generation: () => string, private readonly now: () => number = Date.now, private readonly ttlMs = 15 * 60_000) {
    // refuse predictable empty signing keys
    if (secret.length < 16) throw new Error('host files token secret is too short');
  }

  // issue one session, Place, generation and identity-bound capability
  issue(input: Omit<HostFileTokenPayload, 'version'|'backendGeneration'|'issuedAt'|'expiresAt'|'nonce'>): string {
    const issuedAt = this.now();
    const payload: HostFileTokenPayload = {
      version: 1,
      ...input,
      backendGeneration: this.generation(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      nonce: randomBytes(18).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  // verify one capability for its exact request context
  verify(token: string, expected: { purpose: HostFileTokenPurpose; sessionId: string; placeId?: string }): HostFileTokenPayload | undefined {
    // reject oversized or malformed envelopes before decoding
    if (typeof token !== 'string' || token.length < 20 || token.length > maxTokenBytes) return undefined;
    const parts = token.split('.');
    // require exactly one body and signature
    if (parts.length !== 2) return undefined;
    const [body, signature] = parts as [string, string];
    // reject noncanonical base64url spellings before signature comparison
    if (!/^[A-Za-z0-9_-]+$/u.test(body) || !/^[A-Za-z0-9_-]+$/u.test(signature)
      || Buffer.from(body, 'base64url').toString('base64url') !== body
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature) return undefined;
    const actual = Buffer.from(signature, 'base64url');
    const wanted = Buffer.from(this.sign(body), 'base64url');
    // compare fixed-size signatures without timing disclosure
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return undefined; }
    // require a current, context-bound payload
    if (!isPayload(parsed) || parsed.purpose !== expected.purpose || parsed.sessionId !== expected.sessionId || expected.placeId !== undefined && parsed.placeId !== expected.placeId) return undefined;
    const currentGeneration = this.generation();
    const currentTime = this.now();
    // compare one consistent backend/time snapshot
    if (parsed.backendGeneration !== currentGeneration || parsed.issuedAt > currentTime + 5_000 || parsed.expiresAt < currentTime) return undefined;
    return parsed;
  }

  // sign one encoded token body
  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
