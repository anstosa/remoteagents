import { describe, expect, it } from 'vitest';
import { classifyCodexPane } from '../../src/adapters/codex-panes.js';
import type { Pane, SocketRef } from '../../src/domain/models.js';
import type { AgentKind, PaneScan } from '../../src/adapters/types.js';

const socket: SocketRef = { fingerprint: 'socket-a', path: '/tmp/tmux-a', device: 1, inode: 2 };
const pane = (paneId: string, pid: number, overrides: Partial<Pane> = {}): Pane => ({
  paneId, sessionId: '$s', sessionName: 's', pid, path: '/worktrees/repo', title: paneId, command: 'bash', socket, ...overrides
});
const identity = (p: Pane) => `${p.socket.fingerprint}:${p.paneId}`;

// the agent-agnostic scan facts: which panes are active, recognised as what, and excluded by any Adapter
function scanFor(panes: Pane[], opts: { active?: string[]; kinds?: Record<number, AgentKind>; excluded?: string[] } = {}): PaneScan {
  const active = new Set(opts.active ?? []); const excluded = new Set(opts.excluded ?? []); const kinds = opts.kinds ?? {};
  return { panes, processes: [], identity, sessionIdentity: p => `${p.socket.fingerprint}:${p.sessionId}`, active: p => active.has(identity(p)), recognizedKind: p => kinds[p.pid], excluded: p => excluded.has(identity(p)), paneAncestor: () => undefined };
}

describe('classifyCodexPane', () => {
  it('flags an inactive recognised Codex pane as a stale Codex agent', () => {
    const stale = pane('%5', 500, { title: 'old agent' });
    expect(classifyCodexPane(stale, scanFor([stale], { kinds: { 500: 'codex' } }))).toEqual({ kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old agent at /worktrees/repo' });
  });

  it('leaves active panes, other kinds, unrecognised panes and excluded panes alone', () => {
    const active = pane('%1', 100); const omx = pane('%2', 200); const shell = pane('%3', 300); const hidden = pane('%4', 400, { title: 'hidden' });
    const scan = scanFor([active, omx, shell, hidden], { active: ['socket-a:%1'], kinds: { 100: 'codex', 200: 'omx', 400: 'codex' }, excluded: ['socket-a:%4'] });
    expect(classifyCodexPane(active, scan)).toBeUndefined();
    expect(classifyCodexPane(omx, scan)).toBeUndefined();     // the OMX Adapter's stale rule, not Codex's
    expect(classifyCodexPane(shell, scan)).toBeUndefined();
    // a pane another Adapter hides from the dashboard (an OMX worker running plain Codex)
    // is never a stale Codex agent, whatever its path: the rule reads the scan's
    // `excluded` fact rather than knowing OMX's worker paths itself
    expect(classifyCodexPane(hidden, scan)).toBeUndefined();
  });
});
