import { describe, expect, it } from 'vitest';
import { adapterCapabilities } from '../src/adapters/registry.js';

describe('adapterCapabilities', () => {
  it('keeps Codex launchable with no program in the legacy configuration', () => {
    const codex = adapterCapabilities(undefined).codex;
    expect(codex).toMatchObject({ launchable: true, stateSource: 'title', bookmarks: true });
    expect(codex?.program).toBeUndefined();
    expect(codex?.unavailableReason).toBeUndefined();
  });

  it('publishes the configured program and gates launchability on it', () => {
    const configured = adapterCapabilities({ codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }).codex;
    expect(configured).toMatchObject({ launchable: true, program: '/usr/local/bin/codex' });

    const unavailable = adapterCapabilities({ codex: { program: '/nope', args: [], env: {}, launchable: false, unavailableReason: '/nope is not an executable file' } }).codex;
    expect(unavailable).toMatchObject({ launchable: false, program: '/nope', unavailableReason: '/nope is not an executable file' });
  });

  it('marks a registered kind unlaunchable when an adapters block omits it', () => {
    // an observe-only console: the adapters block exists but configures nothing
    expect(adapterCapabilities({}).codex).toMatchObject({ launchable: false });
    expect(adapterCapabilities({}).codex?.program).toBeUndefined();
  });

  it('derives Claude capabilities: reported state, bookmarks and commands, no turns or inline questions', () => {
    const claude = adapterCapabilities({ claude: { program: '/usr/local/bin/claude', args: [], env: {}, launchable: true } }).claude;
    expect(claude).toMatchObject({ launchable: true, program: '/usr/local/bin/claude', stateSource: 'reported', bookmarks: true, commands: true, turnCapture: false, inlineQuestions: false, sandbox: false });
  });
});
