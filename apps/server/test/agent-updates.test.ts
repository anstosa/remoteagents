import { describe, expect, it, vi } from 'vitest';
import { AgentUpdateService, normalizedVersion, type AgentUpdateRunner } from '../src/agent-updates/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

// build one minimal update-capable configuration
const configured = (): ValidatedConfig => ({
  name: 'Remote Agents',
  remoteServers: [],
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(['127.0.0.1']),
  pollIntervalMs: 500,
  newAgentCommand: 'codex',
  projects: [],
  adapters: {
    codex: { program: '/bin/codex', args: [], env: {}, launchable: true, updates: { current: 'current', latest: 'latest', run: 'update' } },
    omx: { program: '/bin/omx', args: [], env: {}, launchable: true }
  }
});

describe('agent updates', () => {
  it('normalizes terminal output to one bounded version line', () => {
    expect(normalizedVersion('\x1b[32m0.153.2\x1b[0m\nextra')).toBe('0.153.2');
    expect(normalizedVersion('\n\r')).toBeUndefined();
  });

  it('compares configured versions in registry order and caches the result', async () => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? '0.152.1\n' : '0.153.2\n' }));
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('runs the update once and refreshes the installed version', async () => {
    let current = '0.152.1';
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // promote the installed version through the configured update command
      if (command === 'update') { current = '0.153.2'; return { code: 0, output: 'updated' }; }
      return { code: 0, output: command === 'current' ? current : '0.153.2' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    await service.statuses();
    expect(await service.update('codex')).toEqual({ outcome: 'updated', status: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } });
    expect(runner.mock.calls.map(call => call[0])).toEqual(['current', 'latest', 'update', 'current', 'latest']);
  });

  it('serializes updates and reports command failures safely', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner = vi.fn<AgentUpdateRunner>(async command => {
      // hold the first update so a concurrent request sees the busy state
      if (command === 'update') { await gate; return { code: 1, output: 'secret failure details' }; }
      return { code: 0, output: '1.0.0' };
    });
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    const pending = service.update('codex');
    expect(await service.update('codex')).toEqual({ outcome: 'busy' });
    release();
    expect(await pending).toEqual({ outcome: 'failed' });
    expect(await service.update('omx')).toEqual({ outcome: 'unavailable' });
  });
});
