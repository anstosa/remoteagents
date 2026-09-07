import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type TemporaryPreviewTarget = { port: number; createdAt: string; expiresAt: string };

const tokenPattern = /^[A-Za-z0-9_-]{32}$/u;
const maximumLifetimeMs = 7 * 24 * 60 * 60_000;

// parse one helper-owned registration
const parseRegistration = (value: unknown): TemporaryPreviewTarget | undefined => {
  // require one exact object shape
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const registration = value as { version?: unknown; port?: unknown; createdAt?: unknown; expiresAt?: unknown };
  const { port, createdAt: createdAtValue, expiresAt: expiresAtValue } = registration;
  const createdAt = typeof createdAtValue === 'string' ? Date.parse(createdAtValue) : Number.NaN;
  const expiresAt = typeof expiresAtValue === 'string' ? Date.parse(expiresAtValue) : Number.NaN;
  // restrict every target to one bounded unprivileged loopback port
  if (registration.version !== 1 || typeof port !== 'number' || !Number.isInteger(port) || port < 1_024 || port > 65_535 || typeof createdAtValue !== 'string' || typeof expiresAtValue !== 'string' || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > maximumLifetimeMs) return undefined;
  return { port, createdAt: createdAtValue, expiresAt: expiresAtValue };
};

export class TemporaryPreviewService {
  constructor(private readonly directory = process.env.RAC_TEMP_PREVIEWS_DIR ?? '.data/temp-previews', private readonly now: () => number = Date.now) {}

  // resolve one unguessable unexpired registration
  async resolve(token: string): Promise<TemporaryPreviewTarget | undefined> {
    // reject path material before storage access
    if (!tokenPattern.test(token)) return undefined;
    const file = join(this.directory, `${token}.json`);
    const serialized = await readFile(file, 'utf8').catch(() => undefined);
    // ignore missing or unreadable registrations
    if (serialized === undefined || serialized.length > 4_096) return undefined;
    let raw: unknown;
    // ignore malformed helper state
    try { raw = JSON.parse(serialized); }
    catch { return undefined; }
    const registration = parseRegistration(raw);
    // ignore invalid helper state
    if (registration === undefined) return undefined;
    const current = this.now();
    const createdAt = Date.parse(registration.createdAt);
    const expiresAt = Date.parse(registration.expiresAt);
    // enforce the lifetime against the current server clock
    if (createdAt > current || expiresAt > current + maximumLifetimeMs) return undefined;
    // expire and remove stale registrations
    if (expiresAt <= current) {
      await unlink(file).catch(() => undefined);
      return undefined;
    }
    return registration;
  }
}
