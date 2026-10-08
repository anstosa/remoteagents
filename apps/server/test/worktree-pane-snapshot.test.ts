import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pane, PaneListingSnapshot } from '../src/domain/models.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { testConfig, testWorktree } from './helpers/config.js';

const worktree = testWorktree({ id: 'project:/worktree', path: '/worktree', commands: { processes: { dev: 'node dev.js' } } });
const discovery = { worktreesNow: () => [worktree] };
const socket = { path: '/host-tmux/default', fingerprint: 'one', device: 1, inode: 2 };
const pane: Pane = { paneId: '%1', sessionId: '$1', windowId: '@1', path: '/worktree', pid: 123, title: '', command: 'node', role: 'process', processName: 'dev', processWorktree: '/worktree', dead: false, socket };
// wrap one complete dashboard observation
const snapshot = (panes: readonly Pane[]): PaneListingSnapshot => ({ status: 'available', panes });
// preserve environment isolation
afterEach(() => vi.unstubAllEnvs());

// a fresh fallback listing reports no panes and git metadata unavailable
const fixture = () => {
  vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
  const command = vi.fn(async (_binary: string, args: string[]) => ({ code: args.includes('list-panes') ? 0 : 1, stdout: '' }));
  const service = new WorktreeCommandService(testConfig(), discovery as never, command);
  return { service, command };
};

describe('dashboard stack pane sharing', () => {
  // stack display reuses the exact discovery observation
  it('uses matching snapshots and still reads fresh for removal checks', async () => {
    const { service, command } = fixture();
    expect(await service.state(worktree, new Map([[socket.path, snapshot([pane])]]))).toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    expect(command.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(0);
    expect(await service.runningProcesses(worktree)).toEqual([]);
    expect(command.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(1);
  });

  // dead panes have no cwd but an exit status of zero remains meaningful
  it('preserves dead process state and zero exit status', async () => {
    const { service, command } = fixture();
    expect(await service.state(worktree, new Map([[socket.path, snapshot([{ ...pane, path: '', dead: true, exitCode: 0 }])]]))).toMatchObject({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 0 }] });
    expect(command.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(0);
  });

  // an empty successful observation means stopped without another subprocess
  it('uses successful empty snapshots', async () => {
    const { service, command } = fixture();
    expect(await service.state(worktree, new Map([[socket.path, snapshot([])]]))).toMatchObject({ running: false });
    expect(command.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(0);
  });

  // another socket or incomplete metadata must never hide live processes
  it.each(['missing', 'wrong', 'incomplete'] as const)('falls back for a %s snapshot', async kind => {
    const { service, command } = fixture();
    const snapshots = kind === 'missing' ? undefined : kind === 'wrong' ? new Map([['/another/socket', snapshot([pane])]]) : new Map([[socket.path, snapshot([{ ...pane, dead: undefined }])]]);
    await service.state(worktree, snapshots);
    expect(command.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(1);
  });

  // native commands use the default socket in the restricted subprocess environment
  it('shares the native default socket', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', undefined);
    const path = `/tmp/tmux-${process.getuid?.() ?? 0}/default`;
    const command = vi.fn(async () => ({ code: 1, stdout: '' }));
    const service = new WorktreeCommandService(testConfig(), discovery as never, command);
    expect(await service.state(worktree, new Map([[path, snapshot([{ ...pane, socket: { ...socket, path } }])]]))).toMatchObject({ running: true });
    // only the notice-directory git lookup remains
    expect(command.mock.calls).toHaveLength(1);
  });
});
