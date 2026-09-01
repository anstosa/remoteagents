import { describe, expect, it, vi } from 'vitest';
import { CleanupService } from '../src/cleanup/service.js';
import type { HostProcess } from '../src/discovery/processes.js';
import type { Pane, SocketRef } from '../src/domain/models.js';

const socket: SocketRef = { fingerprint: 'socket-a', path: '/tmp/tmux-a', device: 1, inode: 2 };
const pane = (paneId: string, sessionId: string, pid: number, overrides: Partial<Pane> = {}): Pane => ({
  paneId,
  sessionId,
  sessionName: sessionId.slice(1),
  pid,
  path: '/worktrees/repo',
  title: paneId,
  command: 'bash',
  socket,
  ...overrides
});
const host = (pid: number, parentPid: number, cmdline: string, startTime = String(pid)): HostProcess => ({ pid, parentPid, cmdline, startTime, comm: 'MainThread' });

describe('runtime cleanup', () => {
  it('classifies orphan workers, unrepresented Codex panes, HUD panes, and detached HUD watchers without duplicates', async () => {
    const panes = [
      pane('%1', '$team', 100, { title: 'leader' }),
      pane('%2', '$team', 200, { path: '/repo/.omx/team/demo/worktrees/worker-1' }),
      pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }),
      pane('%4', '$hud', 400, { title: 'HUD' }),
      pane('%5', '$stale', 500, { title: 'old agent' })
    ];
    const processes = [
      host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0'),
      host(600, 1, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0', 'start-600')
    ];
    const codex = new Set([100, 200, 300, 500]);
    const service = new CleanupService(
      { refresh: async () => [{ id: 'socket-a:%1' } as never] },
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => codex.has(pid) ? { kind: 'codex' as const, pid, wrapped: false } : undefined, listProcesses: async () => processes }
    );

    const targets = await service.scan();

    expect(targets.map(target => target.kind).sort()).toEqual(['hud-pane', 'hud-process', 'orphan-worker', 'stale-agent']);
    expect(targets).not.toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('%2') })]));
    expect(targets.find(target => target.kind === 'hud-pane')?.detail).toContain('HUD');
    expect(targets.find(target => target.kind === 'hud-process')?.detail).toContain('600');
    expect(new Set(targets.map(target => target.id)).size).toBe(targets.length);
    expect(targets.every(target => /^cleanup-[A-Za-z0-9_-]{24}$/u.test(target.id))).toBe(true);
  });

  it('cleans selected targets, dismisses unchecked targets, and leaves failures pending until they disappear', async () => {
    let panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$stale', 500)];
    const closed: string[] = [];
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      {
        listPanes: async () => panes,
        close: async (_socket, paneId) => { closed.push(paneId); return paneId !== '%3'; },
        terminateHostProcess: async () => true
      },
      { recognizeAgent: async pid => (pid === 300 || pid === 500) ? { kind: 'codex' as const, pid, wrapped: false } : undefined, listProcesses: async () => [] }
    );
    const initial = await service.scan();
    const orphan = initial.find(target => target.kind === 'orphan-worker')!;
    const stale = initial.find(target => target.kind === 'stale-agent')!;

    await expect(service.cleanup([orphan.id])).resolves.toEqual([orphan]);
    expect(closed).toEqual(['%3']);
    expect(service.pending()).toEqual([orphan]);

    panes = [];
    await expect(service.scan()).resolves.toEqual([]);
    panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$stale', 500)];
    await expect(service.scan()).resolves.toEqual(expect.arrayContaining([orphan, stale]));
  });

  it('issues no adapter teardown when killing panes: cleanup only closes them', async () => {
    // cleanup kills worker/HUD/stale panes, where a leader's teardown would be wrong
    const shell: string[] = [];
    const tmux = { listPanes: async () => [pane('%5', '$stale', 500)], close: async () => true, terminateHostProcess: async () => true, runShell: async (_socket: SocketRef, command: string) => { shell.push(command); return true; } };
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      tmux,
      { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }), listProcesses: async () => [] }
    );
    const [target] = await service.scan();
    await expect(service.cleanup([target!.id])).resolves.toEqual([]);
    expect(shell).toEqual([]);
  });

  it('rejects duplicate, unknown, and malformed target selections', async () => {
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      { listPanes: async () => [pane('%5', '$stale', 500)], close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }), listProcesses: async () => [] }
    );
    const [target] = await service.scan();
    await expect(service.cleanup([target!.id, target!.id])).resolves.toBeUndefined();
    await expect(service.cleanup(['cleanup-unknown'])).resolves.toBeUndefined();
    await expect(service.cleanup('all')).resolves.toBeUndefined();
  });
});
