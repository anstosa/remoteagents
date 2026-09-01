import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUntrackedLineStats, DiscoveryService, gitComparisonSummary, gitStatusSummary, gitUpstreamSummary, ProcSocketFinder } from '../src/discovery/service.js';
import { inlineQuestionId, pendingOmxQuestion } from '../src/adapters/codex-questions.js';
import type { SocketRef } from '../src/domain/models.js';
import type { WorktreeEntry } from '../src/git/worktrees.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';
import { testProject } from './helpers/config.js';

// one `git worktree list --porcelain` entry; omit `branch` for a detached checkout
const entry = (path: string, branch?: string, extra: Partial<WorktreeEntry> = {}): WorktreeEntry => ({ path, head: 'abcdef1234567', detached: branch === undefined, bare: false, locked: false, prunable: false, ...(branch === undefined ? {} : { branch }), ...extra });
// an injectable `listWorktrees` keyed by Project path; an unknown path means git failed
const listImpl = (byPath: Record<string, WorktreeEntry[]>) => async (path: string): Promise<WorktreeEntry[] | undefined> => byPath[path];

// write one representative Codex rollout under a home, returning its absolute path
async function writeRollout(home: string, id: string, prompt: string): Promise<string> {
  const directory = join(home, 'sessions', '2026', '08', '20');
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id, cwd: '/host/cora', originator: 'codex-tui' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }
  ];
  const file = join(directory, `rollout-2026-08-20T12-00-00-${id}.jsonl`);
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

// build a fake /proc where each pid holds the given rollout files open
async function buildProc(proc: string, holdings: Record<number, string[]>): Promise<void> {
  for (const [pid, files] of Object.entries(holdings)) {
    await mkdir(join(proc, pid, 'task', pid), { recursive: true });
    await writeFile(join(proc, pid, 'task', pid, 'children'), '');
    await mkdir(join(proc, pid, 'fd'), { recursive: true });
    await Promise.all(files.map((file, index) => symlink(file, join(proc, pid, 'fd', String(index + 3)))));
  }
}

describe('DiscoveryService dashboard', () => {
  it('summarizes staged, unstaged, untracked, and conflicted worktree files', () => {
    expect(gitStatusSummary(' M modified.ts\nM  staged.ts\nMM both.ts\n?? new.ts\nUU conflict.ts\nR  old.ts -> renamed.ts\n')).toEqual({
      files: 6,
      staged: 3,
      unstaged: 2,
      untracked: 1,
      conflicted: 1,
      changes: [
        { code: ' M', path: 'modified.ts', category: 'implementation' },
        { code: 'M ', path: 'staged.ts', category: 'implementation' },
        { code: 'MM', path: 'both.ts', category: 'implementation' },
        { code: '??', path: 'new.ts', category: 'implementation' },
        { code: 'UU', path: 'conflict.ts', category: 'implementation' },
        { code: 'R ', path: 'renamed.ts', originalPath: 'old.ts', category: 'implementation' }
      ]
    });
    expect(gitStatusSummary('')).toEqual({ files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes: [] });
  });

  it('preserves spaces and rename origins from nul-delimited porcelain output', () => {
    expect(gitStatusSummary(
      'R  new name.ts\0old name.ts\0?? untracked file.md\0',
      ['4\t2\t\0old name.ts\0new name.ts\0']
    )).toMatchObject({
      files: 2,
      staged: 1,
      untracked: 1,
      changes: [
        { code: 'R ', path: 'new name.ts', originalPath: 'old name.ts', additions: 4, deletions: 2 },
        { code: '??', path: 'untracked file.md' }
      ]
    });
  });

  it('combines line changes from multiple numstat passes and leaves binary counts unavailable', () => {
    expect(gitStatusSummary(
      'MM mixed.ts\0 M binary.png\0',
      ['3\t1\tmixed.ts\0-\t-\tbinary.png\0', '2\t4\tmixed.ts\0']
    ).changes).toEqual([
      { code: 'MM', path: 'mixed.ts', additions: 5, deletions: 5, category: 'implementation' },
      { code: ' M', path: 'binary.png', category: 'implementation' }
    ]);
  });

  it('reports commits available from the configured branch upstream', async () => {
    const command = vi.fn(async (_binary: string, args: string[]) => args.includes('rev-parse')
      ? { code: 0, stdout: 'origin/feature\n' }
      : { code: 0, stdout: '2\t3\n' });

    await expect(gitUpstreamSummary('/worktrees/cora', command)).resolves.toEqual({ upstream: 'origin/feature', ahead: 2, behind: 3 });
    expect(command).toHaveBeenLastCalledWith('/usr/bin/git', ['-C', '/worktrees/cora', 'rev-list', '--left-right', '--count', 'HEAD...origin/feature']);
  });

  it('omits branches without a usable configured upstream', async () => {
    const command = vi.fn(async () => ({ code: 128, stdout: '' }));

    await expect(gitUpstreamSummary('/worktrees/cora', command)).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  // cover PR comparison parsing
  it('summarizes merge-base changes with renames and current untracked files', () => {
    expect(gitComparisonSummary(
      'origin/main',
      'M\x00src/changed.ts\x00R100\x00docs/old.md\x00docs/new.md\x00A\x00assets/image.png\x00',
      '3\t1\tsrc/changed.ts\x002\t2\t\x00docs/old.md\x00docs/new.md\x00-\t-\tassets/image.png\x00',
      [{ code: '??', path: 'notes/local.txt', additions: 4, deletions: 0 }]
    )).toEqual({
      base: 'origin/main',
      files: 4,
      changes: [
        { code: 'M ', path: 'src/changed.ts', additions: 3, deletions: 1, category: 'implementation' },
        { code: 'R ', path: 'docs/new.md', originalPath: 'docs/old.md', additions: 2, deletions: 2, category: 'doc' },
        { code: 'A ', path: 'assets/image.png', category: 'implementation' },
        { code: '??', path: 'notes/local.txt', additions: 4, deletions: 0 }
      ]
    });
  });

  it('bounds untracked line-stat enrichment by file count and aggregate bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-untracked-stats-'));
    try {
      await Promise.all([
        writeFile(join(workspace, 'one.txt'), 'one\ntwo\n'),
        writeFile(join(workspace, 'two.txt'), 'three\nfour\n'),
        writeFile(join(workspace, 'three.txt'), 'five\nsix\n')
      ]);
      const summary = gitStatusSummary('?? one.txt\n?? two.txt\n?? three.txt\n');

      await addUntrackedLineStats(workspace, summary, { files: 2, bytes: 16, bytesPerFile: 16 });

      expect(summary.changes).toEqual([
        { code: '??', path: 'one.txt', additions: 2, deletions: 0, category: 'implementation' },
        { code: '??', path: 'two.txt', category: 'implementation' },
        { code: '??', path: 'three.txt', category: 'implementation' }
      ]);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('discovers tmux sockets directly from the mounted socket directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-tmux-'));
    const socketPath = join(directory, 'default');
    const server = createServer();
    const previous = process.env.RAC_HOST_TMUX_DIR;
    process.env.RAC_HOST_TMUX_DIR = directory;
    try {
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
      await expect(new ProcSocketFinder().find()).resolves.toEqual([expect.objectContaining({ path: socketPath })]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.RAC_HOST_TMUX_DIR; else process.env.RAC_HOST_TMUX_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('ignores listening sockets outside the tmux socket directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-unix-'));
    const tmuxDirectory = join(directory, 'tmux-1000');
    await mkdir(tmuxDirectory);
    const tmuxSocket = join(tmuxDirectory, 'default');
    const otherSocket = join(directory, 'other.sock');
    const table = join(directory, 'unix');
    const servers = [createServer(), createServer()];
    const previous = { dir: process.env.RAC_HOST_TMUX_DIR, source: process.env.RAC_HOST_TMUX_SOURCE, table: process.env.RAC_HOST_UNIX_SOCKETS };
    delete process.env.RAC_HOST_TMUX_DIR;
    process.env.RAC_HOST_TMUX_SOURCE = tmuxDirectory;
    process.env.RAC_HOST_UNIX_SOCKETS = table;
    try {
      await Promise.all([tmuxSocket, otherSocket].map((path, index) => new Promise<void>((resolve, reject) => servers[index]!.once('error', reject).listen(path, resolve))));
      await writeFile(table, `Num RefCount Protocol Flags Type St Inode Path\n0001: 00000002 00000000 00010000 0001 01 1 ${otherSocket}\n0002: 00000002 00000000 00010000 0001 01 2 ${tmuxSocket}\n`);
      await expect(new ProcSocketFinder().find()).resolves.toEqual([expect.objectContaining({ path: tmuxSocket })]);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      for (const [key, value] of [['RAC_HOST_TMUX_DIR', previous.dir], ['RAC_HOST_TMUX_SOURCE', previous.source], ['RAC_HOST_UNIX_SOCKETS', previous.table]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('associates a host tmux path with the discovered Main worktree by its host path', async () => {
    const finder = socketFinder();
    const tmux = paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }]);
    const processes = processInspector({ codex: true });
    const project = testProject({ id: 'ferry', label: 'Ferry FYI', path: '/worktrees/ferry', hostPath: '/host/ferry', newTask: 'new {taskId}', push: { label: 'Commit/Push', prompt: '$push' }, projectUrl: 'https://ferry.agents.example.com', projectPort: 4000 });
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], undefined, listImpl({ '/worktrees/ferry': [entry('/worktrees/ferry', 'main')] }));

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toHaveLength(1);
    // the pane's host path matches the Main worktree's hostPath, not its console path
    expect(dashboard.agents[0]).toMatchObject({ workspace: '/worktrees/ferry', projectId: 'ferry', worktreeId: 'ferry:/worktrees/ferry', newTaskConfigured: true, push: { label: 'Commit/Push', prompt: '$push' }, projectUrl: 'https://ferry.agents.example.com' });
    // the Worktree is carried under its Project; an active Worktree omits idle git metadata
    expect(dashboard.projects[0]?.worktrees).toMatchObject([{ id: 'ferry:/worktrees/ferry', main: true, pinned: true }]);
  });

  it('prefers a valid reported @rac_session over the conversation the fd-walk finds, and reads its title', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [
      // pane %1 reports a valid session; pane %2 reports garbage and must fall back to the fd-walk
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora', reportedSession: '0198c111-1111-7111-8111-111111111111' },
      { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy', reportedSession: 'not-a-session' }
    ] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'Reported conversation');
      const walkedFirst = await writeRollout(home, '0198c333-3333-7333-8333-333333333333', 'Walked by pane one');
      const walkedSecond = await writeRollout(home, '0198c777-7777-7777-8777-777777777777', 'Walked by pane two');
      await buildProc(proc, { 123: [walkedFirst], 456: [walkedSecond] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      // the valid reported id wins over the different conversation the fd-walk would return
      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'Reported conversation' });
      // a malformed report is rejected and falls back to the fd-walk
      await expect(service.conversationId(agents[1]!.id)).resolves.toBe('0198c777-7777-7777-8777-777777777777');
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it('falls back to the fd-walk and isolates each pane to its own conversation', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
      { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy' }
    ] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      const first = await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'First conversation');
      const second = await writeRollout(home, '0198c333-3333-7333-8333-333333333333', 'Second conversation');
      await buildProc(proc, { 123: [first], 456: [second] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversationId(agents[1]!.id)).resolves.toBe('0198c333-3333-7333-8333-333333333333');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'First conversation' });
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it('resolves the conversation by working directory when the fd-walk is blocked', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    // one pane whose descriptors a confined service cannot readlink
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' }] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      // writeRollout records cwd '/host/cora' in session_meta, matching the pane path
      await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'Confined conversation');
      await buildProc(proc, { 123: [], 456: [] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'Confined conversation' });

      // two blocked panes sharing the directory fail closed rather than share a conversation
      const shared = { listPanes: async () => [
        { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
        { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy' }
      ] };
      const crowded = new DiscoveryService(finder, shared as never, processInspector());
      const both = await crowded.refresh();
      await expect(crowded.conversation(both[0]!.id)).resolves.toBeUndefined();
      await expect(crowded.conversation(both[1]!.id)).resolves.toBeUndefined();
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it('preserves a custom tmux display label for launched scratch agents', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Codex', displayLabel: '~ Scratch' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    await expect(service.dashboard()).resolves.toMatchObject({ agents: [{ displayLabel: '~ Scratch' }] });
  });

  it('keeps an update advisor separate from its configured repository worktree', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%2', sessionId: '$1', pid: 456, path: '/host/remoteagents', title: 'Ready', displayLabel: 'Update Advisor Starting v4 2222222' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const project = testProject({ id: 'remoteagents', label: 'Remote Agents', path: '/workspace', hostPath: '/host/remoteagents' });
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], undefined, listImpl({ '/workspace': [entry('/workspace', 'main')] }));

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([expect.objectContaining({ paneId: '%2', workspace: '/host/remoteagents', displayLabel: 'Update Advisor Starting v4 2222222' })]);
    // a modal advisor never claims the Project's Main worktree, which stays idle in projects[]
    expect(dashboard.agents[0]).not.toHaveProperty('worktreeId');
    expect(dashboard.projects[0]?.worktrees).toEqual([expect.objectContaining({ id: 'remoteagents:/workspace' })]);
  });

  it('resolves reported @rac_* pane options over the inferred title and publishes adapter capabilities', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedAttention: 'question', reportedSession: 'abc-123', reportedSandboxed: '1' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    // reported 'question' wins over the title's inferred 'finished'
    expect(dashboard.agents[0]).toMatchObject({ kind: 'codex', attention: 'question', sandboxed: true, conversationId: 'abc-123' });
    expect(dashboard.adapters).toMatchObject({ codex: { launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: true, commands: true, sandbox: false } });
  });

  it('clears stale @rac_* only on a non-agent pane that still carries a report', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const unset: string[] = [];
    const tmux = {
      listPanes: async () => [
        { paneId: '%9', sessionId: '$0', pid: 999, path: '/tmp', title: 'shell', reportedAttention: 'working' },
        // a plain shell with no report must not be touched
        { paneId: '%8', sessionId: '$0', pid: 998, path: '/tmp', title: 'shell' }
      ],
      unsetReportedState: async (_socket: SocketRef, pane: string) => { unset.push(pane); return true; }
    };
    const processes = { recognizeAgent: async () => undefined };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([]);
    expect(unset).toEqual(['%9']);
  });

  it('records a sandboxed agent only for the exact @rac_sandboxed sentinel and ignores an empty session', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedSandboxed: '0', reportedSession: '' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents[0]).not.toHaveProperty('sandboxed');
    expect(dashboard.agents[0]).not.toHaveProperty('conversationId');
  });

  it('does not expose OMX team workers as dashboard agents', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
      { paneId: '%2', sessionId: '$0', pid: 124, path: '/host/cora/.omx/team/signup/worktrees/worker-1', title: 'worker-1' },
      { paneId: '%3', sessionId: '$0', pid: 125, path: '/host/cora', title: 'worker-2', startCommand: "exec /bin/sh '/tmp/run/.omx/state/team/signup/runtime/worker-2-startup.sh'" }
    ] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([expect.objectContaining({ paneId: '%1', title: 'Cora' })]);
  });

  it('coalesces concurrent discovery requests and reuses a fresh snapshot', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let inspections = 0;
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }] };
    const processes = { recognizeAgent: async (pid: number) => { inspections += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { kind: 'codex' as const, pid, wrapped: false }; } };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
    const third = await service.refresh();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(finds).toBe(1);
    expect(inspections).toBe(1);
  });

  it('forces a fresh dashboard for lifecycle revalidation', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Ready';
    let listings = 0;
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title }]; } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const first = await service.dashboard();
    title = '⠋ Working';
    const cached = await service.dashboard();
    const fresh = await service.dashboard(true);

    expect(first.agents[0]?.title).toBe('Ready');
    expect(cached.agents[0]?.title).toBe('Ready');
    expect(fresh.agents[0]?.title).toBe('⠋ Working');
    expect(listings).toBe(2);
  });

  it('forces discovery after an older scan already in flight', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Ready';
    let listings = 0;
    let markListingStarted!: () => void;
    let releaseListing!: () => void;
    const listingStarted = new Promise<void>(resolve => { markListingStarted = resolve; });
    const listingBlocked = new Promise<void>(resolve => { releaseListing = resolve; });
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => {
      listings += 1;
      const capturedTitle = title;
      // hold only the stale scan
      if (listings === 1) {
        markListingStarted();
        await listingBlocked;
      }
      return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: capturedTitle }];
    } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const stale = service.dashboard();
    await listingStarted;
    title = '⠋ Working';
    const fresh = service.dashboard(true);
    releaseListing();

    await expect(stale).resolves.toMatchObject({ agents: [{ title: 'Ready' }] });
    await expect(fresh).resolves.toMatchObject({ agents: [{ title: '⠋ Working' }] });
    expect(listings).toBe(2);
  });

  it('resolves a known target without repeating global discovery after the dashboard cache expires', async () => {
    vi.useFakeTimers();
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let listings = 0;
    let inspections = 0;
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }]; } };
    const processes = { recognizeAgent: async (pid: number) => { inspections += 1; return { kind: 'codex' as const, pid, wrapped: false }; } };
    const service = new DiscoveryService(finder, tmux as never, processes);

    try {
      const [agent] = await service.refresh();
      vi.advanceTimersByTime(2_100);

      await expect(service.target(agent!.id)).resolves.toMatchObject({ agent: { paneId: '%1' }, socket });

      expect(finds).toBe(2);
      expect(listings).toBe(1);
      expect(inspections).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a known target when launch confirmation requires current pane state', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Framework';
    let listings = 0;
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title }]; } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const [agent] = await service.refresh();
    title = 'Ready';

    await expect(service.target(agent!.id, true)).resolves.toMatchObject({ agent: { title: 'Ready' }, socket });
    expect(listings).toBe(2);
  });

  it('coalesces concurrent dashboard enrichment so slow polls cannot accumulate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-dashboard-'));
    let lookups = 0;
    const pullRequests = {
      cachedPullRequest: async () => {
        lookups += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return undefined;
      }
    };
    const project = testProject({ id: 'slow', label: 'Slow', path: workspace });
    const service = new DiscoveryService({ find: async () => [] }, { listPanes: async () => [] } as never, { recognizeAgent: async () => undefined }, pullRequests as never, undefined, [project], undefined, listImpl({ [workspace]: [entry(workspace, 'main')] }));

    try {
      const [first, second] = await Promise.all([service.dashboard(), service.dashboard()]);
      const third = await service.dashboard();

      expect(first).toBe(second);
      expect(third).toBe(first);
      expect(lookups).toBe(1);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('discovers worktrees from git porcelain, excludes bare and stale entries, and shapes them by Project', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', label: 'App', path: '/repo' });
    // an explicit pin override on the detached checkout; the Main worktree pins by default
    const pins = { pins: async () => ({ 'app:/repo/wt-detached': true }) };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pins, listImpl({ '/repo': [
      entry('/repo', 'main'),
      entry('/repo/wt-feature', 'feature'),
      entry('/repo/wt-detached'),
      { path: '/repo.git', detached: false, bare: true, locked: false, prunable: false },
      entry('/repo/gone', 'ghost', { prunable: true }),
      entry('/repo/held', 'held', { locked: true, lockedReason: 'in use' })
    ] }));

    const worktrees = (await service.dashboard()).projects[0]!.worktrees;

    // bare and stale (prunable) entries drop out; Main first, then Linked by branch, detached last
    expect(worktrees.map(view => ({ id: view.id, label: view.label, main: view.main, detached: view.detached, locked: view.locked, pinned: view.pinned, order: view.order }))).toEqual([
      { id: 'app:/repo', label: 'App', main: true, detached: false, locked: false, pinned: true, order: 0 },
      { id: 'app:/repo/wt-feature', label: 'App · feature', main: false, detached: false, locked: false, pinned: false, order: 1 },
      { id: 'app:/repo/held', label: 'App · held', main: false, detached: false, locked: true, pinned: false, order: 2 },
      { id: 'app:/repo/wt-detached', label: 'App · abcdef1', main: false, detached: true, locked: false, pinned: true, order: 3 }
    ]);
  });

  it('reports Prune-eligible stale paths: git prunable entries plus records git lists nowhere', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', label: 'App', path: '/repo' });
    // records: two git still lists (kept), one whose path git lists only as prunable (must be
    // counted once, not again as an orphan), one git lists nowhere (orphan), one for another Project
    const pinStore = { pins: async () => ({}), keys: async () => ['app:/repo', 'app:/repo/wt-feature', 'app:/repo/gone', 'app:/repo/orphan', 'other:/elsewhere'] };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pinStore, listImpl({ '/repo': [
      entry('/repo', 'main'),
      entry('/repo/wt-feature', 'feature'),
      entry('/repo/gone', 'ghost', { prunable: true })
    ] }));

    const stalePaths = (await service.dashboard()).projects[0]!.stalePaths;

    // the prunable checkout (once, though a record also points at it) and the orphaned record
    expect([...stalePaths].sort()).toEqual(['/repo/gone', '/repo/orphan']);
  });

  it('re-reads pins after invalidation and never lets a stale in-flight scan clobber the fresh set', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', path: '/repo' });
    // a pins() that returns the pin state as of when the scan reads it, gated so a scan can be
    // held in flight across an invalidation
    let pinsValue: Record<string, boolean> = { 'app:/repo': false };
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let reads = 0;
    const pinStore = { pins: async () => { reads += 1; if (reads === 1) await firstBlocked; return pinsValue; } };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pinStore, listImpl({ '/repo': [entry('/repo', 'main')] }));

    // scan P1 begins and blocks inside pins() with the old (unpinned) state
    const first = service.worktrees();
    // an operator toggles the pin: invalidate, then flip the store to pinned
    service.invalidateWorktrees();
    pinsValue = { 'app:/repo': true };
    // a fresh read must not coalesce onto the stale P1; it starts P2 reading the new pins
    const second = await service.worktrees();
    expect(second[0]?.pinned).toBe(true);
    // when the stale P1 finally resolves it must not re-stamp the snapshot back to unpinned
    releaseFirst();
    await first;
    expect(service.worktreesNow()[0]?.pinned).toBe(true);
  });

  it('finds a pending OMX question pane associated with its return pane', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-question-'));
    try {
      const questions = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'question-test.json'), JSON.stringify({ kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting', question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }], renderer: { target: '%22', return_target: '%1' } }));
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toEqual({ id: inlineQuestionId('Choose one?', ['Yes', 'No']), text: 'Choose one?', choices: ['Yes', 'No'], source: 'structured', targetPaneId: '%22' });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('resolves a pending inline question to the question state through the dashboard', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-question-dash-'));
    try {
      // git-init so workspaceRoot() resolves to a stable toplevel; build the question dir under it
      execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
      const root = execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      const questions = join(root, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'q.json'), JSON.stringify({ kind: 'omx.question/v1', question_id: 'question-q1', status: 'prompting', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }], renderer: { target: '%9', return_target: '%1' } }));
      const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
      const finder = { find: async () => [socket] };
      const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: workspace, title: 'Ready' }] };
      const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
      const service = new DiscoveryService(finder, tmux as never, processes);

      const dashboard = await service.dashboard();

      // the title infers 'finished', but the pending question outranks it
      expect(dashboard.agents[0]).toMatchObject({ attention: 'question', question: { id: inlineQuestionId('Deploy?', ['Yes', 'No']), text: 'Deploy?', choices: ['Yes', 'No'], source: 'structured', targetPaneId: '%9' } });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
