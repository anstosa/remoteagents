import { describe, expect, it, vi } from 'vitest';

// register a second launchable kind so the multi-kind resolution branch (which reads
// the launch-profile store) is exercised; only Codex is registered in production today.
vi.mock('../src/adapters/registry.js', () => ({
  adapterFor: (kind: string) => (kind === 'codex' || kind === 'claude' ? { kind } : undefined),
}));

const { LaunchService } = await import('../src/launch/service.js');

const twoKinds = (claudeLaunchable = true) => ({
  newAgentCommand: 'codex',
  adapters: {
    codex: { program: '/bin/codex', args: [], env: {}, launchable: true },
    claude: { program: '/bin/claude', args: [], env: {}, launchable: claudeLaunchable }
  },
  worktrees: []
}) as never;
const store = (profile?: string) => ({ launchProfile: async () => profile, rememberLaunchProfile: async () => {} }) as never;

describe('resolveLaunchKind with more than one launchable kind', () => {
  it('honors the remembered launch profile when it is still launchable', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, store('claude'));
    expect(await service.resolveLaunchKind('cora')).toBe('claude');
  });

  it('skips a remembered kind that is no longer launchable and takes the first launchable in registry order', async () => {
    const service = new LaunchService(twoKinds(false), undefined, undefined, undefined, store('claude'));
    expect(await service.resolveLaunchKind('cora')).toBe('codex');
  });

  it('takes the first launchable kind when nothing is remembered', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, store(undefined));
    expect(await service.resolveLaunchKind('cora')).toBe('codex');
  });

  it('refuses a requested kind that is not launchable', async () => {
    const service = new LaunchService(twoKinds(false), undefined, undefined, undefined, store());
    expect(await service.resolveLaunchKind('cora', 'claude')).toBeUndefined();
    expect(await service.resolveLaunchKind('cora', 'pi' as never)).toBeUndefined();
  });
});
