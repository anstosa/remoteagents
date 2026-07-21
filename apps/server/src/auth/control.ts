export class ControlService {
  private owner?: { sessionId: string; expires: number };
  constructor(private readonly now: () => number = Date.now, private readonly leaseMs = 15_000) {}
  private prune(): void { if (this.owner !== undefined && this.owner.expires <= this.now()) this.owner = undefined; }
  connect(sessionId: string): boolean { this.prune(); if (this.owner !== undefined && this.owner.sessionId !== sessionId) return false; this.owner = { sessionId, expires: this.now() + this.leaseMs }; return true; }
  take(sessionId: string): void { this.owner = { sessionId, expires: this.now() + this.leaseMs }; }
  active(sessionId: string): boolean { this.prune(); if (this.owner?.sessionId !== sessionId) return false; this.owner.expires = this.now() + this.leaseMs; return true; }
  release(sessionId: string): void { this.prune(); if (this.owner?.sessionId === sessionId) this.owner = undefined; }
}
