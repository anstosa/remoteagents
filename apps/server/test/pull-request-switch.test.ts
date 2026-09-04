import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { GitCommand } from '../src/git/worktree-state.js';
import { run } from '../src/tmux/command.js';

const worktree = { id: 'cora:/worktrees/cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: true, main: true, detached: false, locked: false };
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, adapters: {}, projects: [] };
const agent = { id: 'agent-1', paneId: '%1', sessionId: '$1', socketFingerprint: 'socket', workspace: worktree.identity, branch: 'feature/current', title: 'Ready' };
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const headSha = 'a'.repeat(40);
const choices = [{ number: 7, title: 'Draft work', branch: 'feature/draft', headSha, headOnOrigin: true, draft: true, url: 'https://github.com/octo/repo/pull/7' }];

const commonRepositoryResult = { code: 0, stdout: '/repositories/project/.git\n' };
const cleanCommand = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('--git-common-dir') ? commonRepositoryResult.stdout : args.includes('status') ? '' : 'refs/remotes/origin/feature/current\n' });

// simulate one branch changing after pane input
function switchingCommand(initialBranch = 'feature/current') {
  let branch = initialBranch;
  let completed = false;
  return {
    select: (next: string) => { branch = next; completed = true; },
    command: async (binary: string, args: string[]) => {
      // expose shell completion only after pane input finishes
      if (binary === '/usr/bin/cat') return { code: completed ? 0 : 1, stdout: completed ? '0\n' : '' };
      // accept completion marker cleanup
      if (binary === '/usr/bin/rm') return { code: 0, stdout: '' };
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // expose clean working state
      if (args.includes('status')) return { code: 0, stdout: '' };
      // expose the current branch before and after input
      if (args.includes('symbolic-ref')) return { code: 0, stdout: `${branch}\n` };
      return { code: 0, stdout: 'refs/remotes/origin/feature/current\n' };
    }
  };
}

// create one linked repository fixture
async function createMoveRepository(withSubmodule = false) {
  const root = await mkdtemp(join(tmpdir(), 'rac-pr-move-'));
  const targetPath = join(root, 'cora');
  const sourcePath = join(root, 'delta');
  await run('/usr/bin/git', ['init', targetPath]);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.name', 'Test User']);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(targetPath, 'tracked.txt'), 'original\n');
  await run('/usr/bin/git', ['-C', targetPath, 'add', 'tracked.txt']);
  await run('/usr/bin/git', ['-C', targetPath, 'commit', '-m', 'initial']);
  // add one dirty state that normal stash cannot capture
  if (withSubmodule) {
    const submoduleSource = join(root, 'module-source');
    await run('/usr/bin/git', ['init', submoduleSource]);
    await run('/usr/bin/git', ['-C', submoduleSource, 'config', 'user.name', 'Test User']);
    await run('/usr/bin/git', ['-C', submoduleSource, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(submoduleSource, 'module.txt'), 'original module\n');
    await run('/usr/bin/git', ['-C', submoduleSource, 'add', 'module.txt']);
    await run('/usr/bin/git', ['-C', submoduleSource, 'commit', '-m', 'module']);
    await run('/usr/bin/git', ['-c', 'protocol.file.allow=always', '-C', targetPath, 'submodule', 'add', submoduleSource, 'module']);
    await run('/usr/bin/git', ['-C', targetPath, 'commit', '-am', 'add module']);
  }
  await run('/usr/bin/git', ['-C', targetPath, 'branch', '-M', 'main']);
  await run('/usr/bin/git', ['-C', targetPath, 'branch', 'feature/draft']);
  await run('/usr/bin/git', ['-C', targetPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await run('/usr/bin/git', ['-C', targetPath, 'worktree', 'add', sourcePath, 'feature/draft']);
  // initialize the linked submodule fixture
  if (withSubmodule) await run('/usr/bin/git', ['-c', 'protocol.file.allow=always', '-C', sourcePath, 'submodule', 'update', '--init']);
  const head = await run('/usr/bin/git', ['-C', sourcePath, 'rev-parse', 'HEAD']);
  return { root, targetPath, sourcePath, headSha: head.stdout.trim() };
}

// add staged, unstaged, and untracked source changes
async function dirtyMoveSource(sourcePath: string) {
  await writeFile(join(sourcePath, 'tracked.txt'), 'staged\n');
  await run('/usr/bin/git', ['-C', sourcePath, 'add', 'tracked.txt']);
  await writeFile(join(sourcePath, 'tracked.txt'), 'staged\nunstaged\n');
  await writeFile(join(sourcePath, 'notes.txt'), 'untracked\n');
}

// assemble one standard move service around a real repository
function moveService(repository: Awaited<ReturnType<typeof createMoveRepository>>, tmux: object, command: GitCommand = run) {
  const targetWorktree = { ...worktree, id: `cora:${repository.targetPath}`, path: repository.targetPath, identity: repository.targetPath };
  const sourceWorktree = { ...worktree, id: 'delta', projectId: 'cora', label: 'Delta', path: repository.sourcePath, identity: repository.sourcePath };
  const targetAgent = { ...agent, workspace: repository.targetPath, branch: 'main' };
  const sourceAgent = { ...agent, id: 'agent-2', paneId: '%2', workspace: repository.sourcePath, branch: 'feature/draft', worktreeId: 'delta' };
  const discovery = {
    worktreesNow: () => [targetWorktree, sourceWorktree],
    target: async (id: string) => id === targetAgent.id ? { agent: targetAgent, socket } : id === sourceAgent.id ? { agent: sourceAgent, socket } : undefined,
    dashboard: async () => ({ generation: 1, agents: [targetAgent, sourceAgent], projects: [] })
  };
  const pulls = { supports: async () => true, open: async () => ({ own: [{ ...choices[0], headSha: repository.headSha }], others: [] }) };
  const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, command);
  return { service, targetAgent };
}

describe('pull request switching', () => {
  it('finds GitHub Actions for configured worktrees and scratch repositories', async () => {
    const requested: string[] = [];
    const pulls = { actionsUrl: async (workspace: string) => { requested.push(workspace); return 'https://github.com/octo/repo/actions'; } };
    const configured = new PullRequestSwitchService(config, { worktreesNow: () => [worktree], target: async () => ({ agent, socket }) } as never, {} as never, pulls as never, cleanCommand);
    const scratchAgent = { ...agent, workspace: '/scratch/repo' };
    const scratch = new PullRequestSwitchService(config, { worktreesNow: () => [worktree], target: async () => ({ agent: scratchAgent, socket }) } as never, {} as never, pulls as never, cleanCommand);

    await expect(configured.actionsUrl(agent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    await expect(scratch.actionsUrl(scratchAgent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    expect(requested).toEqual([worktree.identity, scratchAgent.workspace]);
  });

  it('marks a pull request unavailable when another agent has its branch checked out', async () => {
    const discovery = { worktreesNow: () => [worktree, { ...worktree, id: 'delta', label: 'Delta' }], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'feature/draft', worktreeId: 'delta' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const tmux = { suspend: async () => true, input: async () => true };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [] });
    await expect(service.switch(agent.id, 7)).resolves.toBe(false);
  });

  // reject a no-op checkout in the current worktree
  it('marks a pull request unavailable when the target worktree already has its branch checked out', async () => {
    const currentAgent = { ...agent, branch: 'feature/draft', worktreeId: worktree.id };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent: currentAgent, socket }), dashboard: async () => ({ generation: 1, agents: [currentAgent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // expose the current symbolic branch
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'feature/draft\n' };
      return await cleanCommand(_binary, args);
    };
    let suspended = false;
    const tmux = { suspend: async () => { /* detect unintended suspension */ suspended = true; return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, command);

    await expect(service.available(currentAgent.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { agentId: 'agent-1', worktreeId: worktree.id, worktreeName: 'Cora' } }], otherPullRequests: [] });
    await expect(service.switch(currentAgent.id, 7)).resolves.toBe(false);
    expect(suspended).toBe(false);
  });

  // prefer the live branch over cached dashboard metadata
  it('marks the live target branch checked out when the dashboard branch is stale', async () => {
    const staleAgent = { ...agent, worktreeId: worktree.id };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent: staleAgent, socket }), dashboard: async () => ({ generation: 1, agents: [staleAgent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // expose the branch changed after dashboard caching
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'feature/draft\n' };
      return await cleanCommand(_binary, args);
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(staleAgent.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: true, openIn: { agentId: 'agent-1', worktreeId: worktree.id, worktreeName: 'Cora' } }] });
  });

  it('matches linked worktrees whose common repository has different mount paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-pr-repository-alias-'));
    try {
      const common = join(root, 'common.git');
      const targetAlias = join(root, 'target.git');
      const sourceAlias = join(root, 'source.git');
      await mkdir(common);
      await symlink(common, targetAlias, 'dir');
      await symlink(common, sourceAlias, 'dir');
      const sourceWorktree = { ...worktree, id: 'delta', label: 'Delta', identity: '/worktrees/delta', path: '/worktrees/delta' };
      const sourceAgent = { ...agent, id: 'agent-2', workspace: sourceWorktree.identity, branch: 'feature/draft', worktreeId: 'delta' };
      const discovery = { worktreesNow: () => [worktree, sourceWorktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, sourceAgent], projects: [] }) };
      const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
      const command = async (_binary: string, args: string[]) => {
        // expose two paths for one repository directory
        if (args.includes('--git-common-dir')) return { code: 0, stdout: `${args[1] === worktree.identity ? targetAlias : sourceAlias}\n` };
        return await cleanCommand(_binary, args);
      };
      const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

      await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // preserve the newest git state after remote metadata loading
  it('checks worktree readiness after loading pull request metadata', async () => {
    let pullRequestsLoaded = false;
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = {
      supports: async () => true,
      open: async () => {
        // delay the simulated remote lookup
        await Promise.resolve();
        // finish the worktree transition
        pullRequestsLoaded = true;
        return { own: choices, others: [] };
      }
    };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // expose the state transition to clean
      if (args.includes('status')) return { code: 0, stdout: pullRequestsLoaded ? '' : ' M apps/server/src/app.ts\n' };
      return { code: 0, stdout: 'refs/remotes/origin/feature/current\n' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('identifies a pull request checked out in an inactive worktree', async () => {
    const deltaView = { id: 'delta', projectId: 'cora', label: 'Delta', path: '/worktrees/delta', available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'feature/draft' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [deltaView] }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [] });
  });

  it('ignores matching branch names from another repository', async () => {
    const otherWorktree = { ...worktree, id: 'delta', label: 'Delta', path: '/worktrees/delta', identity: '/worktrees/delta' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [{ ...agent, id: 'agent-2', workspace: otherWorktree.identity, branch: 'feature/draft', worktreeId: 'delta' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // separate repository identities by worktree path
      if (args.includes('--git-common-dir')) return { code: 0, stdout: args[1] === worktree.identity ? '/repositories/target/.git\n' : '/repositories/source/.git\n' };
      return await cleanCommand(_binary, args);
    };
    let suspended = false;
    const tmux = { suspend: async () => { suspended = true; return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: false }] });
    await expect(service.move(agent.id, 7)).resolves.toBe('unavailable');
    expect(suspended).toBe(false);
  });

  it('moves an occupied pull request here and recovers every source change', async () => {
    const repository = await createMoveRepository();
    try {
      await writeFile(join(repository.targetPath, 'tracked.txt'), 'existing stash\n');
      await run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'push', '--message', 'existing backup']);
      await dirtyMoveSource(repository.sourcePath);
      const calls: string[] = [];
      const tmux = {
        suspend: async (_socket: unknown, pane: string) => { calls.push(`suspend:${pane}`); return true; },
        foreground: async (_socket: unknown, pane: string) => { calls.push(`foreground:${pane}`); return true; }
      };
      const { service, targetAgent } = moveService(repository, tmux);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('moved');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      await expect(readFile(join(repository.targetPath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(readFile(join(repository.targetPath, 'notes.txt'), 'utf8')).resolves.toBe('untracked\n');
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: 'MM tracked.txt\n?? notes.txt\n' });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'list'])).resolves.toMatchObject({ stdout: expect.stringContaining('existing backup') });
      expect(calls).toEqual(['suspend:%2', 'suspend:%1', 'foreground:%2', 'foreground:%1']);
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('restores the source branch and changes when the target checkout fails', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // fail only the destination checkout
        if (args[1] === repository.targetPath && args[2] === 'switch' && args.at(-1) === 'feature/draft') return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const tmux = { suspend: async () => true, foreground: async () => true };
      const { service, targetAgent } = moveService(repository, tmux, command);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(readFile(join(repository.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(readFile(join(repository.sourcePath, 'notes.txt'), 'utf8')).resolves.toBe('untracked\n');
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: 'MM tracked.txt\n?? notes.txt\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('revalidates the source branch after both agents suspend', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const tmux = {
        suspend: async (_socket: unknown, pane: string) => {
          // simulate a source branch change during suspension
          if (pane === '%2') await run('/usr/bin/git', ['-C', repository.sourcePath, 'switch', '-c', 'feature/other']);
          return true;
        },
        foreground: async () => true
      };
      const { service, targetAgent } = moveService(repository, tmux);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/other\n' });
      await expect(readFile(join(repository.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('never applies an existing stash when the dirty state cannot be stashed', async () => {
    const repository = await createMoveRepository(true);
    try {
      await writeFile(join(repository.targetPath, 'tracked.txt'), 'existing stash\n');
      await run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'push', '--message', 'existing backup']);
      await writeFile(join(repository.sourcePath, 'module', 'module.txt'), 'dirty module\n');
      const tmux = { suspend: async () => true, foreground: async () => true };
      const { service, targetAgent } = moveService(repository, tmux);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(readFile(join(repository.sourcePath, 'module', 'module.txt'), 'utf8')).resolves.toBe('dirty module\n');
      const stashes = await run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list']);
      expect(stashes.stdout.match(/^stash@/gmu)).toHaveLength(1);
      expect(stashes.stdout).toContain('existing backup');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports recovery-required when rollback cannot restore the source branch', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // fail destination checkout and source rollback
        if (args[2] === 'switch' && args.at(-1) === 'feature/draft') return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const tmux = { suspend: async () => true, foreground: async () => true };
      const { service, targetAgent } = moveService(repository, tmux, command);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('recovery-required');

      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: expect.stringContaining('PR #7') });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports recovery-required when a created stash cannot be identified', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // hide the newly created stash from exact recovery tracking
        if (args[1] === repository.sourcePath && args[2] === 'stash' && args[3] === 'list' && args.includes('--format=%H%x09%gs')) return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const tmux = { suspend: async () => true, foreground: async () => true };
      const { service, targetAgent } = moveService(repository, tmux, command);

      await expect(service.move(targetAgent.id, 7)).resolves.toBe('recovery-required');

      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: expect.stringContaining('PR #7') });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('suspends, switches, clears, and resumes an available agent', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const calls: string[] = [];
    const git = switchingCommand();
    const tmux = { suspend: async () => { calls.push('suspend'); return true; }, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); git.select('feature/draft'); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, git.command);

    await expect(service.switch(agent.id, 7)).resolves.toBe(true);
    expect(calls[0]).toBe('suspend');
    expect(calls[1]).toContain('git fetch origin --no-tags --force');
    expect(calls[1]).toContain('refs/heads/feature/draft:refs/remotes/origin/feature/draft');
    expect(calls[1]).toContain(`test "$(git rev-parse`);
    expect(calls[1]).toContain(headSha);
    expect(calls[1]).toContain('git switch -c');
    expect(calls[1]).toContain('refs/remotes/origin/feature/draft');
    expect(calls[1]).toMatch(/^\x15.*; clear; fg\r$/s);
  });

  it('blocks a move until an asynchronous pane switch completes', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const git = switchingCommand();
    let inputStarted!: () => void;
    const started = new Promise<void>(resolve => { inputStarted = resolve; });
    const tmux = {
      suspend: async () => true,
      input: async () => {
        // expose the polling interval before the branch changes
        inputStarted();
        return true;
      }
    };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, git.command);

    const switching = service.switch(agent.id, 7);
    await started;
    await expect(service.move(agent.id, 7)).resolves.toBe('unavailable');
    git.select('feature/draft');
    await expect(switching).resolves.toBe(true);
  });

  it('records an interrupted shell command before releasing the mutation lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-pr-switch-shell-'));
    const binaryPath = join(root, 'git');
    const shells: Promise<void>[] = [];
    try {
      await writeFile(binaryPath, '#!/bin/sh\nif [ "$RAC_TEST_GIT_MODE" = "fail" ]; then exit 1; fi\ntrap \'exit 130\' INT TERM\nkill -INT 0\nexit 130\n');
      await chmod(binaryPath, 0o755);
      const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
      const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
      const git = switchingCommand();
      const command: GitCommand = async (binary, args) => {
        // read real completion markers written by the wrapped shell
        if (binary === '/usr/bin/cat' || binary === '/usr/bin/rm') return await run(binary, args);
        return await git.command(binary, args);
      };
      let inputCalls = 0;
      const tmux = {
        suspend: async () => true,
        input: async (_socket: unknown, _pane: string, value: string) => {
          inputCalls += 1;
          const child = spawn('/bin/bash', ['-c', value.slice(1, -1)], {
            cwd: root,
            detached: true,
            env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, RAC_TEST_GIT_MODE: inputCalls === 1 ? 'hang' : 'fail' },
            stdio: 'ignore'
          });
          shells.push(new Promise(resolve => { child.once('exit', () => resolve()); }));
          return true;
        }
      };
      const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, command);

      await expect(service.switch(agent.id, 7)).resolves.toBe(false);
      await expect(service.switch(agent.id, 7)).resolves.toBe(false);
      expect(inputCalls).toBe(2);
      await Promise.all(shells);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  // preserve non-owner targets behind the secondary group
  it('returns and switches pull requests by other authors', async () => {
    const otherHeadSha = 'b'.repeat(40);
    const other = { number: 8, title: 'Other work', branch: 'main', headSha: otherHeadSha, headOnOrigin: false, draft: false, url: 'https://github.com/octo/repo/pull/8' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'main' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [other] }) };
    const calls: string[] = [];
    const git = switchingCommand();
    const tmux = { suspend: async () => true, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); git.select(`rac/pr/8/${otherHeadSha.slice(0, 12)}`); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, git.command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 7 }], otherPullRequests: [{ number: 8, branch: 'main', checkoutBranch: `rac/pr/8/${otherHeadSha.slice(0, 12)}`, checkedOut: false }] });
    await expect(service.switch(agent.id, 8)).resolves.toBe(true);
    expect(calls[0]).toContain('git fetch origin --no-tags --force');
    expect(calls[0]).toContain('refs/pull/8/head:refs/rac/pull/8');
    expect(calls[0]).toContain(otherHeadSha);
    expect(calls[0]).toContain('git switch -c');
    expect(calls[0]).toContain(`rac/pr/8/${otherHeadSha.slice(0, 12)}`);
    expect(calls[0]).not.toContain('origin/main');
  });

  // preserve fork identity independently from author identity
  it('uses the pinned pull request ref for a viewer-authored fork', async () => {
    const forkHeadSha = 'c'.repeat(40);
    const fork = { number: 9, title: 'Viewer fork', branch: 'main', headSha: forkHeadSha, headOnOrigin: false, draft: false, url: 'https://github.com/octo/repo/pull/9' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'main' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: [fork], others: [] }) };
    const calls: string[] = [];
    const git = switchingCommand();
    const tmux = { suspend: async () => true, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); git.select(`rac/pr/9/${forkHeadSha.slice(0, 12)}`); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, git.command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 9, checkoutBranch: `rac/pr/9/${forkHeadSha.slice(0, 12)}`, checkedOut: false }], otherPullRequests: [] });
    await expect(service.switch(agent.id, 9)).resolves.toBe(true);
    expect(calls[0]).toContain("refs/pull/9/head:refs/rac/pull/9");
    expect(calls[0]).not.toContain('origin/main');
  });

  it('allows switching when HEAD is pushed to a remote branch without a configured upstream', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('for-each-ref')) return { code: 0, stdout: 'refs/remotes/origin/main\n' };
      return { code: 128, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean detached HEAD without requiring a remote ref', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean branch whose configured upstream is gone', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'refs/heads/feature/merged\n' };
      if (args.includes('--contains=HEAD')) return { code: 0, stdout: '' };
      if (args.includes('--format=%(upstream:track)')) return { code: 0, stdout: '[gone]\n' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('keeps switching disabled when a clean HEAD is not present on any remote branch', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('--git-common-dir') ? commonRepositoryResult.stdout : '' });
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: false });
  });
});
