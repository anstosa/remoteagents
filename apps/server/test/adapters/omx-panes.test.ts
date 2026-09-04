import { describe, expect, it } from 'vitest';
import { classifyOmxPane, classifyOmxProcess, isOmxWorkerPane } from '../../src/adapters/omx-panes.js';
import { isHudWatcherCommand } from '../../src/adapters/omx-processes.js';
import type { HostProcess } from '../../src/discovery/processes.js';
import type { Pane, SocketRef } from '../../src/domain/models.js';
import type { AgentKind, PaneScan } from '../../src/adapters/types.js';

const socket: SocketRef = { fingerprint: 'socket-a', path: '/tmp/tmux-a', device: 1, inode: 2 };
const pane = (paneId: string, sessionId: string, pid: number, overrides: Partial<Pane> = {}): Pane => ({
  paneId, sessionId, sessionName: sessionId.slice(1), pid, path: '/worktrees/repo', title: paneId, command: 'bash', socket, ...overrides
});
const host = (pid: number, parentPid: number, cmdline: string, startTime = String(pid)): HostProcess => ({ pid, parentPid, cmdline, startTime, comm: 'MainThread' });
const identity = (p: Pane) => `${p.socket.fingerprint}:${p.paneId}`;
const worker = (n: number) => `/repo/.omx/team/demo/worktrees/worker-${n}`;

// build a PaneScan whose derivations mirror what the CleanupService supplies; `excluded`
// is the registry's answer, which for these panes is the OMX worker rule itself
function scanFor(panes: Pane[], processes: HostProcess[], opts: { active?: string[]; kinds?: Record<number, AgentKind> } = {}): PaneScan {
  const active = new Set(opts.active ?? []);
  const kinds = opts.kinds ?? {};
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
  return { panes, processes, identity, sessionIdentity: p => `${p.socket.fingerprint}:${p.sessionId}`, active: p => active.has(identity(p)), recognizedKind: p => kinds[p.pid], excluded: p => isOmxWorkerPane(p), paneAncestor };
}

describe('isHudWatcherCommand', () => {
  it('recognizes direct and Node-launched OMX HUD watchers only', () => {
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0--watch\0')).toBe(true);
    expect(isHudWatcherCommand(['node', '/home/ubuntu/bin/omx', 'hud', '--interval', '1', '--watch', ''].join('\0'))).toBe(true);
    expect(isHudWatcherCommand('/usr/bin/node\0/opt/oh-my-codex/dist/cli/omx.js\0hud\0--watch\0')).toBe(true);
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0')).toBe(false);
    expect(isHudWatcherCommand('node\0/app/server.js\0--watch\0')).toBe(false);
  });
});

describe('isOmxWorkerPane', () => {
  it('matches OMX worker worktrees and startup scripts only', () => {
    expect(isOmxWorkerPane({ path: worker(1), startCommand: undefined })).toBe(true);
    expect(isOmxWorkerPane({ path: '/repo', startCommand: 'bash /repo/.omx/state/team/demo/runtime/worker-2-startup.sh' })).toBe(true);
    expect(isOmxWorkerPane({ path: '/worktrees/repo', startCommand: 'codex' })).toBe(false);
  });

  it('keeps a console-managed launch visible inside an old OMX worker checkout', () => {
    expect(isOmxWorkerPane({ path: worker(1), startCommand: undefined, consoleManaged: true })).toBe(false);
  });
});

describe('classifyOmxPane', () => {
  it('classifies HUD panes, orphan workers, and stale OMX agents; skips leaders and workers with a leader', () => {
    const panes = [
      pane('%1', '$team', 100, { title: 'leader' }),
      pane('%2', '$team', 200, { path: worker(1) }),
      pane('%3', '$orphan', 300, { path: worker(2) }),
      pane('%4', '$hud', 400, { title: 'HUD' }),
      pane('%5', '$stale', 500, { title: 'old agent' })
    ];
    const processes = [host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0')];
    // the leader is OMX; team workers run plain Codex
    const scan = scanFor(panes, processes, { active: ['socket-a:%1'], kinds: { 100: 'omx', 200: 'codex', 300: 'codex', 500: 'omx' } });

    expect(classifyOmxPane(panes[0]!, scan)).toBeUndefined();               // active OMX leader
    expect(classifyOmxPane(panes[1]!, scan)).toBeUndefined();               // worker with a session leader
    expect(classifyOmxPane(panes[2]!, scan)?.kind).toBe('orphan-worker');
    expect(classifyOmxPane(panes[3]!, scan)?.kind).toBe('hud-pane');
    expect(classifyOmxPane(panes[4]!, scan)).toEqual({ kind: 'stale-agent', label: 'Stale OMX agent', detail: 'old agent at /worktrees/repo' });
  });

  it('accepts a plain Codex leader for a worker session', () => {
    const panes = [pane('%1', '$team', 100, { title: 'leader' }), pane('%2', '$team', 200, { path: worker(1) })];
    const scan = scanFor(panes, [], { active: ['socket-a:%1'], kinds: { 100: 'codex', 200: 'codex' } });
    expect(classifyOmxPane(panes[1]!, scan)).toBeUndefined();
  });

  it('never counts an excluded pane or a HUD pane as a session leader', () => {
    // a worker session whose only recognised panes are workers and a HUD has no leader
    const panes = [pane('%2', '$team', 200, { path: worker(1) }), pane('%3', '$team', 300, { path: worker(2) }), pane('%4', '$team', 400, { startCommand: '/home/ubuntu/bin/omx hud --watch' })];
    const scan = scanFor(panes, [], { kinds: { 200: 'codex', 300: 'omx', 400: 'omx' } });
    expect(classifyOmxPane(panes[0]!, scan)?.kind).toBe('orphan-worker');
    expect(classifyOmxPane(panes[1]!, scan)?.kind).toBe('orphan-worker');
    expect(classifyOmxPane(panes[2]!, scan)?.kind).toBe('hud-pane');
  });

  it('leaves stale Codex panes to the Codex Adapter and never calls an excluded pane a stale agent', () => {
    const panes = [pane('%5', '$stale', 500, { title: 'old codex' }), pane('%6', '$team', 600, { path: worker(1) }), pane('%7', '$team', 700, { title: 'leader' })];
    const scan = scanFor(panes, [], { active: ['socket-a:%7'], kinds: { 500: 'codex', 600: 'omx', 700: 'omx' } });
    expect(classifyOmxPane(panes[0]!, scan)).toBeUndefined();
    expect(classifyOmxPane(panes[1]!, scan)).toBeUndefined();
  });

  it('treats a pane whose start command runs the HUD watcher as a HUD pane', () => {
    const hudPane = pane('%9', '$hud', 900, { startCommand: '/home/ubuntu/bin/omx hud --watch' });
    const scan = scanFor([hudPane], []);
    expect(classifyOmxPane(hudPane, scan)?.kind).toBe('hud-pane');
  });
});

describe('classifyOmxProcess', () => {
  it('flags a detached HUD watcher and ignores one still under a pane', () => {
    const hudPane = pane('%4', '$hud', 400);
    const attached = host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0');
    const detached = host(600, 1, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0', 'start-600');
    const scan = scanFor([hudPane], [attached, detached]);
    expect(classifyOmxProcess(attached, scan)).toBeUndefined();
    expect(classifyOmxProcess(detached, scan)?.kind).toBe('hud-process');
    expect(classifyOmxProcess(host(700, 1, 'node\0/app/server.js\0'), scan)).toBeUndefined();
  });
});
