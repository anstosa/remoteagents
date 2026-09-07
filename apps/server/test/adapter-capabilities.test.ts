import { describe, expect, it } from 'vitest';
import { adapterCapabilities } from '../src/adapters/registry.js';

describe('adapterCapabilities', () => {
  it('publishes intrinsic Codex capabilities unlaunchable in an observe-only configuration', () => {
    const codex = adapterCapabilities({}).codex;
    expect(codex).toMatchObject({ launchable: false, stateSource: 'title', bookmarks: true });
    expect(codex?.program).toBeUndefined();
    expect(codex?.unavailableReason).toBeUndefined();
  });

  it('derives the three conversation capabilities: bookmarks, naming and listing on every kind', () => {
    // `bookmarks` is the conversations facet's presence, `naming` its rename, `conversations` its list;
    // every registered kind names, bookmarks and lists (Codex and OMX share one rollout reader, ADR 0005)
    for (const kind of ['codex', 'omx', 'claude'] as const) {
      expect(adapterCapabilities({})[kind], kind).toMatchObject({ bookmarks: true, naming: true, conversations: true });
    }
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

  it('derives Claude capabilities: reported state, bookmarks, naming, listing, commands and inline questions, no turns', () => {
    const claude = adapterCapabilities({ claude: { program: '/usr/local/bin/claude', args: [], env: {}, launchable: true } }).claude;
    expect(claude).toMatchObject({ launchable: true, program: '/usr/local/bin/claude', stateSource: 'reported', bookmarks: true, naming: true, conversations: true, commands: true, turnCapture: false, inlineQuestions: true, sandbox: false });
  });
});
