const defaultVoiceLeaseMs = 25_000;

type VoiceLease = { browserSessionId: string; voiceSessionId: string; startedAt: number; expiresAt: number };

export type ExternalControlSnapshot = {
  voiceActive: boolean;
  startedAt?: string;
  expiresAt?: string;
};

export type ExternalControlResult =
  | { ok: true }
  | { ok: false; code: 'voice_mode_required' | 'browser_control_changed' };

// gate mutations on active browser voice mode
export class IntegrationControlService {
  private voice?: VoiceLease;
  private readonly stopped = new Map<string, number>();

  // retain the active browser-owner resolver
  constructor(private readonly browserOwner: () => string | undefined, private readonly now: () => number = Date.now, private readonly leaseMs = defaultVoiceLeaseMs) {}

  // start voice mode for the controlling browser
  startVoice(browserSessionId: string, voiceSessionId: string): boolean {
    this.prune();
    // reject stale or non-controlling sessions
    if (this.browserOwner() !== browserSessionId || this.stopped.has(voiceSessionId)) return false;
    const now = this.now();
    this.voice = { browserSessionId, voiceSessionId, startedAt: now, expiresAt: now + this.leaseMs };
    return true;
  }

  // renew one active voice session
  heartbeatVoice(browserSessionId: string, voiceSessionId: string): boolean {
    this.prune();
    // require the same active browser voice session
    if (this.voice?.browserSessionId !== browserSessionId || this.voice.voiceSessionId !== voiceSessionId || this.browserOwner() !== browserSessionId) return false;
    this.voice.expiresAt = this.now() + this.leaseMs;
    return true;
  }

  // stop voice mode immediately
  stopVoice(browserSessionId: string, voiceSessionId: string): void {
    this.prune();
    this.stopped.set(voiceSessionId, this.now() + this.leaseMs);
    // cap cancellation tombstones
    if (this.stopped.size > 64) this.stopped.delete(this.stopped.keys().next().value as string);
    // preserve a different browser's newer session
    if (this.voice?.browserSessionId === browserSessionId && this.voice.voiceSessionId === voiceSessionId) this.voice = undefined;
  }

  // authorize one mutation only while voice is active
  authorizeMutation(): ExternalControlResult {
    this.prune();
    // require a live voice session
    if (this.voice === undefined) return { ok: false, code: 'voice_mode_required' };
    // revoke after browser ownership changes
    if (this.browserOwner() !== this.voice.browserSessionId) {
      this.voice = undefined;
      return { ok: false, code: 'browser_control_changed' };
    }
    return { ok: true };
  }

  // expose only safe voice-gate metadata
  snapshot(): ExternalControlSnapshot {
    this.prune();
    // hide inactive voice state
    if (this.voice === undefined) return { voiceActive: false };
    return { voiceActive: true, startedAt: new Date(this.voice.startedAt).toISOString(), expiresAt: new Date(this.voice.expiresAt).toISOString() };
  }

  // expire abandoned browser voice sessions
  private prune(): void {
    // release stale voice sessions
    if (this.voice !== undefined && this.voice.expiresAt <= this.now()) this.voice = undefined;
    // release expired cancellation tombstones
    for (const [id, expiresAt] of this.stopped) {
      // retain live cancellation records
      if (expiresAt > this.now()) continue;
      this.stopped.delete(id);
    }
  }
}
