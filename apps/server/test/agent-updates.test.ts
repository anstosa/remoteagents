import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentUpdateService, normalizedVersion, type AgentUpdateRunner } from '../src/agent-updates/service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import * as command from '../src/tmux/command.js';

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
  // restore host settings and command spies between cases
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // cover compose host paths and the legacy workspace override
  it.each([
    { repository: '/host/console', workspace: undefined, expected: '/host/console' },
    { repository: '/host/console', workspace: '/host/legacy', expected: '/host/console' },
    { repository: undefined, workspace: '/host/legacy', expected: '/host/legacy' }
  ])('checks versions through the host checkout $expected', async ({ repository, workspace, expected }) => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-agent-updates-'));
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_TMUX_BIN', '/host-tools/tmux');
    vi.stubEnv('RAC_HOST_REPOSITORY', repository);
    vi.stubEnv('RAC_HOST_WORKSPACE', workspace);
    // publish completion files without starting a real host session
    const run = vi.spyOn(command, 'run').mockImplementation(async (binary, args) => {
      expect(binary).toBe('/host-tools/tmux');
      // complete only the synthetic version commands
      if (args.includes('new-session')) {
        const session = args[args.indexOf('-s') + 1]!;
        const token = session.replace('rac-agent-update-', '');
        const script = args.at(-1)!;
        expect(args.slice(0, 2)).toEqual(['-S', '/host-tmux/default']);
        expect(script).toContain(`'${expected}/.data/agent-updates/${token}.out'`);
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.out`), script.includes('{ current; }') ? '1.0.0\n' : '1.1.0\n');
        await writeFile(join(checkout, '.data', 'agent-updates', `${token}.status`), '0');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      const service = new AgentUpdateService(configured(), '/home/test', undefined, checkout);
      await expect(service.statuses()).resolves.toEqual([{ kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);
      expect(run).toHaveBeenCalledTimes(4);
      expect(await readdir(join(checkout, '.data', 'agent-updates'))).toEqual([]);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

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

  // tolerate a slow registry while keeping version checks bounded
  it.each([
    { lookupMs: 20_000, succeeds: true },
    { lookupMs: 35_000, succeeds: false }
  ])('bounds a registry lookup taking $lookupMs ms', async ({ lookupMs, succeeds }) => {
    vi.useFakeTimers();
    // model a command that completes or reaches the supplied deadline
    const runner: AgentUpdateRunner = async (command, timeoutMs) => {
      // installed versions do not wait for the registry
      if (command === 'current') return { code: 0, output: '1.0.0' };
      await new Promise(resolve => setTimeout(resolve, Math.min(lookupMs, timeoutMs)));
      return lookupMs < timeoutMs ? { code: 0, output: '1.1.0' } : { code: -1, output: '' };
    };
    try {
      const pending = new AgentUpdateService(configured(), '/home/test', runner).statuses();
      await vi.advanceTimersByTimeAsync(Math.min(lookupMs, 30_000));
      await expect(pending).resolves.toEqual([succeeds
        ? { kind: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }
        : { kind: 'codex', updateAvailable: false, error: 'Version check failed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // compare semantic precedence and equivalent forms
  it.each([
    { current: '0.10.0', latest: '0.9.0', updateAvailable: false },
    { current: 'v1.2.3', latest: '1.2.3', updateAvailable: false },
    { current: '1.2.3+installed', latest: '1.2.3+registry', updateAvailable: false },
    { current: '1.2.3-rc.1', latest: '1.2.3', updateAvailable: true }
  ])('compares $current with $latest using semver precedence', async ({ current, latest, updateAvailable }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => ({ code: 0, output: command === 'current' ? current : latest }));
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', currentVersion: current, latestVersion: latest, updateAvailable }]);
  });

  // suppress every failed version response
  it.each([
    { failure: 'both outputs are present but one is invalid', current: { code: 0, output: 'development' }, latest: { code: 0, output: '1.2.3' } },
    { failure: 'the invalid current output accompanies a failed latest command', current: { code: 0, output: 'development' }, latest: { code: 1, output: 'registry error' } },
    { failure: 'the invalid latest output accompanies a failed current command', current: { code: 1, output: 'binary error' }, latest: { code: 0, output: 'development' } }
  ])('omits version output when $failure', async ({ current, latest }) => {
    const runner = vi.fn<AgentUpdateRunner>(async command => command === 'current' ? current : latest);
    const service = new AgentUpdateService(configured(), '/home/test', runner);
    expect(await service.statuses()).toEqual([{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }]);
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
