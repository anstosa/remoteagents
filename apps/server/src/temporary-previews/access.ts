import { randomBytes } from 'node:crypto';

const maximumGrants = 2_048;

type Grant = { token: string; expiresAt: number };

export class TemporaryPreviewAccess {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly now: () => number = Date.now) {}

  // issue one path-scoped browser grant
  issue(token: string, expiresAt: number): string {
    this.prune();
    const value = randomBytes(24).toString('base64url');
    this.grants.set(value, { token, expiresAt });
    return value;
  }

  // verify one live grant for the exact preview
  allows(value: string | undefined, token: string): boolean {
    // reject missing grants
    if (value === undefined) return false;
    const grant = this.grants.get(value);
    const now = this.now();
    // discard expired grants on access
    if (grant !== undefined && grant.expiresAt <= now) this.grants.delete(value);
    return grant !== undefined && grant.expiresAt > now && grant.token === token;
  }

  // prune expired and excess grants
  private prune(): void {
    const now = this.now();
    // remove every expired grant
    for (const [value, grant] of this.grants) {
      // retain live grants
      if (grant.expiresAt > now) continue;
      this.grants.delete(value);
    }
    // bound process memory
    while (this.grants.size >= maximumGrants) {
      const oldest = this.grants.keys().next();
      // stop if the map changed unexpectedly
      if (oldest.done) return;
      this.grants.delete(oldest.value);
    }
  }
}

// serialize one isolated preview cookie
export const temporaryPreviewCookie = (value: string, token: string, expiresAt: number, secure: boolean, now = Date.now()) => {
  const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1_000));
  return `rac-preview=${value}; Path=/preview/${token}/; Max-Age=${seconds}; HttpOnly; ${secure ? 'Secure; SameSite=None' : 'SameSite=Lax'}`;
};
