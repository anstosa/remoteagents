import type { ValidatedConfig } from '../../src/config/schema.js';

/**
 * The canonical validated config every HTTP-layer test starts from. Spread
 * overrides for the fields a test cares about, e.g.
 * `testConfig({ worktrees: [worktree] })`.
 */
export function testConfig(overrides: Partial<ValidatedConfig> = {}): ValidatedConfig {
  return {
    name: 'Remote Agents',
    remoteServers: [],
    listen: { host: '127.0.0.1', port: 8787 },
    publicOrigin: new URL('https://agents.example.com'),
    trustedProxyIps: new Set(['127.0.0.1']),
    pollIntervalMs: 500,
    newAgentCommand: 'codex',
    worktrees: [],
    ...overrides,
  };
}
