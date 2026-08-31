import { describe, expect, it } from 'vitest';
import { classifyCodexPane, classifyCodexProcess, isHudWatcherCommand, isOmxWorkerPane } from '../../src/adapters/codex-panes.js';
import type { HostProcess } from '../../src/discovery/processes.js';
import type { Pane, SocketRef } from '../../src/domain/models.js';
import type { PaneScan } from '../../src/adapters/types.js';

const socket: SocketRef = { fingerprint: 'socket-a', path: '/tmp/tmux-a', device: 1, inode: 2 };
const pane = (paneId: string, sessionId: string, pid: number, overrides: Partial<Pane> = {}): Pane => ({
  paneId, sessionId, sessionName: sessionId.slice(1), pid, path: '/worktrees/repo', title: paneId, command: 'bash', socket, ...overrides
});
const host = (pid: number, parentPid: number, cmdline: string, startTime = String(pid)): HostProcess => ({ pid, parentPid, cmdline, startTime, comm: 'MainThread' });
const identity = (p: Pane) => `${p.socket.fingerprint}:${p.paneId}`;

// build a PaneScan whose derivations mirror what the CleanupService supplies
function scanFor(panes: Pane[], processes: HostProcess[], opts: { active?: string[]; codex?: number[] } = {}): PaneScan {
  const active = new Set(opts.active ?? []);
  const codex = new Set(opts.codex ?? panes.map(p => p.pid));
  const paneByPid = new Map(panes.map(p => [p.pid, p]));
  const processByPid = new Map(processes.map(p => [p.pid, p]));
  const paneAncestor = (pid: number): Pane | undefined => {
    const seen = new Set<number>(); let current = pid;
    while (current > 0 && seen.size < 256 && !seen.has(current)) {
      const found = paneByPid.get(current); if (found !== undefined) return found;
      seen.add(current); current = processByPid.get(current)?.parentPid ?? 0;
    }
    return undefined;
  };
  return { panes, processes, identity, sessionIdentity: p => `${p.socket.fingerprint}:${p.sessionId}`, active: p => active.has(identity(p)), recognizedKind: p => codex.has(p.pid) ? 'codex' : undefined, paneAncestor };
}

describe('isHudWatcherCommand', () => {
  it('recognizes direct and Node-launched OMX HUD watchers only', () => {
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0--watch\0')).toBe(true);
    expect(isHudWatcherCommand(['node', '/home/ubuntu/bin/omx', 'hud', '--interval', '1', '--watch', ''].join('\0'))).toBe(true);
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0')).toBe(false);
    expect(isHudWatcherCommand('node\0/app/server.js\0--watch\0')).toBe(false);
  });
});

describe('isOmxWorkerPane', () => {
  it('matches OMX worker worktrees and startup scripts only', () => {
    expect(isOmxWorkerPane({ path: '/repo/.omx/team/demo/worktrees/worker-1', startCommand: undefined })).toBe(true);
    expect(isOmxWorkerPane({ path: '/repo', startCommand: 'bash /repo/.omx/state/team/demo/runtime/worker-2-startup.sh' })).toBe(true);
    expect(isOmxWorkerPane({ path: '/worktrees/repo', startCommand: 'codex' })).toBe(false);
  });
});

describe('classifyCodexPane', () => {
  it('classifies HUD panes, orphan workers, and stale agents; skips leaders and workers with a leader', () => {
    const panes = [
      pane('%1', '$team', 100, { title: 'leader' }),
      pane('%2', '$team', 200, { path: '/repo/.omx/team/demo/worktrees/worker-1' }),
      pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }),
      pane('%4', '$hud', 400, { title: 'HUD' }),
      pane('%5', '$stale', 500, { title: 'old agent' })
    ];
    const processes = [host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0')];
    const scan = scanFor(panes, processes, { active: ['socket-a:%1'], codex: [100, 200, 300, 500] });

    expect(classifyCodexPane(panes[0]!, scan)).toBeUndefined();               // active leader
    expect(classifyCodexPane(panes[1]!, scan)).toBeUndefined();               // worker with a session leader
    expect(classifyCodexPane(panes[2]!, scan)?.kind).toBe('orphan-worker');
    expect(classifyCodexPane(panes[3]!, scan)?.kind).toBe('hud-pane');
    expect(classifyCodexPane(panes[4]!, scan)?.kind).toBe('stale-agent');
  });

  it('treats a pane whose start command runs the HUD watcher as a HUD pane', () => {
    const hudPane = pane('%9', '$hud', 900, { startCommand: '/home/ubuntu/bin/omx hud --watch' });
    const scan = scanFor([hudPane], [], { codex: [] });
    expect(classifyCodexPane(hudPane, scan)?.kind).toBe('hud-pane');
  });
});

describe('classifyCodexProcess', () => {
  it('flags a detached HUD watcher and ignores one still under a pane', () => {
    const hudPane = pane('%4', '$hud', 400);
    const attached = host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0');
    const detached = host(600, 1, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0', 'start-600');
    const scan = scanFor([hudPane], [attached, detached]);
    expect(classifyCodexProcess(attached, scan)).toBeUndefined();
    expect(classifyCodexProcess(detached, scan)?.kind).toBe('hud-process');
    expect(classifyCodexProcess(host(700, 1, 'node\0/app/server.js\0'), scan)).toBeUndefined();
  });
});
