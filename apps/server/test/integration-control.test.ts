import { describe, expect, it } from 'vitest';
import { IntegrationControlService } from '../src/integrations/control/index.js';

describe('IntegrationControlService', () => {
  it('authorizes mutations only during one live browser voice session', () => {
    let owner: string | undefined = 'browser-a';
    let now = 1_000;
    const service = new IntegrationControlService(() => owner, () => now, 100);

    expect(service.authorizeMutation()).toEqual({ ok: false, code: 'voice_mode_required' });
    expect(service.startVoice('browser-a', 'voice-session-123456789')).toBe(true);
    expect(service.authorizeMutation()).toEqual({ ok: true });
    expect(service.heartbeatVoice('browser-a', 'voice-session-123456789')).toBe(true);
    service.stopVoice('browser-a', 'voice-session-123456789');
    expect(service.authorizeMutation()).toEqual({ ok: false, code: 'voice_mode_required' });
    expect(service.startVoice('browser-a', 'voice-session-123456789')).toBe(false);

    now += 101;
    expect(service.startVoice('browser-a', 'voice-session-987654321')).toBe(true);
    owner = 'browser-b';
    expect(service.authorizeMutation()).toEqual({ ok: false, code: 'browser_control_changed' });
  });
});
