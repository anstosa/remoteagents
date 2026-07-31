import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryService, omxQuestion, ProcSocketFinder } from '../src/discovery/service.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';

describe('DiscoveryService dashboard', () => {
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

  it('associates host tmux paths with configured worktrees', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }] };
    const processes = { hasCodexDescendant: async () => true };
    const service = new DiscoveryService(finder, tmux as never, processes);
    const worktrees: Worktree[] = [{ id: 'ferry', label: 'Ferry FYI', path: '/worktrees/ferry', identity: '/worktrees/ferry', hostPath: '/host/ferry', available: true, command: 'codex', newTask: 'new {taskId}', projectUrl: 'https://ferry.agents.example.com' }];

    const dashboard = await service.dashboard(worktrees);

    expect(dashboard.agents).toHaveLength(1);
    expect(dashboard.agents[0]).toMatchObject({ workspace: '/worktrees/ferry', worktreeId: 'ferry', worktreeLabel: 'Ferry FYI', worktreeOrder: 0, newTaskConfigured: true, projectUrl: 'https://ferry.agents.example.com' });
    expect(dashboard.worktrees).toEqual([]);
  });

  it('preserves a custom tmux display label for launched scratch agents', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Codex', displayLabel: '~ Scratch' }] };
    const processes = { hasCodexDescendant: async () => true };
    const service = new DiscoveryService(finder, tmux as never, processes);

    await expect(service.dashboard([])).resolves.toMatchObject({ agents: [{ displayLabel: '~ Scratch' }] });
  });

  it('coalesces concurrent discovery requests and reuses a fresh snapshot', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let inspections = 0;
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }] };
    const processes = { hasCodexDescendant: async () => { inspections += 1; await new Promise(resolve => setTimeout(resolve, 5)); return true; } };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
    const third = await service.refresh();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(finds).toBe(1);
    expect(inspections).toBe(1);
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
    const worktrees: Worktree[] = [{ id: 'slow', label: 'Slow', path: workspace, identity: workspace, available: true, command: 'codex' }];
    const service = new DiscoveryService({ find: async () => [] }, { listPanes: async () => [] } as never, { hasCodexDescendant: async () => false }, pullRequests as never);

    try {
      const [first, second] = await Promise.all([service.dashboard(worktrees), service.dashboard(worktrees)]);
      const third = await service.dashboard(worktrees);

      expect(first).toBe(second);
      expect(third).toBe(first);
      expect(lookups).toBe(1);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('finds a pending OMX question pane associated with its return pane', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-question-'));
    try {
      const questions = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'question-test.json'), JSON.stringify({ kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting', question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }], renderer: { target: '%22', return_target: '%1' } }));
      await expect(omxQuestion(workspace, '%1')).resolves.toEqual({ id: 'question-test', text: 'Choose one?', choices: ['Yes', 'No'], paneId: '%22' });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
