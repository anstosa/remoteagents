import { describe, expect, it } from 'vitest';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] };
const agent = { id: 'agent-1', paneId: '%1', sessionId: '$1', socketFingerprint: 'socket', workspace: worktree.identity, branch: 'feature/current', title: 'Ready' };
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const headSha = 'a'.repeat(40);
const choices = [{ number: 7, title: 'Draft work', branch: 'feature/draft', headSha, headOnOrigin: true, draft: true, url: 'https://github.com/octo/repo/pull/7' }];

const cleanCommand = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('status') ? '' : 'refs/remotes/origin/feature/current\n' });

describe('pull request switching', () => {
  it('finds GitHub Actions for configured worktrees and scratch repositories', async () => {
    const requested: string[] = [];
    const pulls = { actionsUrl: async (workspace: string) => { requested.push(workspace); return 'https://github.com/octo/repo/actions'; } };
    const configured = new PullRequestSwitchService(config, { target: async () => ({ agent, socket }) } as never, {} as never, pulls as never, cleanCommand);
    const scratchAgent = { ...agent, workspace: '/scratch/repo' };
    const scratch = new PullRequestSwitchService(config, { target: async () => ({ agent: scratchAgent, socket }) } as never, {} as never, pulls as never, cleanCommand);

    await expect(configured.actionsUrl(agent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    await expect(scratch.actionsUrl(scratchAgent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    expect(requested).toEqual([worktree.identity, scratchAgent.workspace]);
  });

  it('marks a pull request unavailable when another agent has its branch checked out', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'feature/draft', worktreeId: 'delta', worktreeLabel: 'Delta' }], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const tmux = { suspend: async () => true, input: async () => true };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [] });
    await expect(service.switch(agent.id, 7)).resolves.toBe(false);
  });

  // preserve the newest git state after remote metadata loading
  it('checks worktree readiness after loading pull request metadata', async () => {
    let pullRequestsLoaded = false;
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
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
      // expose the state transition to clean
      if (args.includes('status')) return { code: 0, stdout: pullRequestsLoaded ? '' : ' M apps/server/src/app.ts\n' };
      return { code: 0, stdout: 'refs/remotes/origin/feature/current\n' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('identifies a pull request checked out in an inactive worktree', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [{ id: 'delta', label: 'Delta', branch: 'feature/draft' }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [] });
  });

  it('suspends, switches, clears, and resumes an available agent', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const calls: string[] = [];
    const tmux = { suspend: async () => { calls.push('suspend'); return true; }, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, cleanCommand);

    await expect(service.switch(agent.id, 7)).resolves.toBe(true);
    expect(calls[0]).toBe('suspend');
    expect(calls[1]).toContain("git fetch origin --no-tags --force 'refs/heads/feature/draft:refs/remotes/origin/feature/draft'");
    expect(calls[1]).toContain(`test "$(git rev-parse 'refs/remotes/origin/feature/draft^{commit}')" = '${headSha}'`);
    expect(calls[1]).toContain("git switch -c 'feature/draft' --track 'refs/remotes/origin/feature/draft'");
    expect(calls[1]).toMatch(/^\x15.*; clear; fg\r$/s);
  });

  // preserve non-owner targets behind the secondary group
  it('returns and switches pull requests by other authors', async () => {
    const otherHeadSha = 'b'.repeat(40);
    const other = { number: 8, title: 'Other work', branch: 'main', headSha: otherHeadSha, headOnOrigin: false, draft: false, url: 'https://github.com/octo/repo/pull/8' };
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'main' }], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [other] }) };
    const calls: string[] = [];
    const tmux = { suspend: async () => true, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 7 }], otherPullRequests: [{ number: 8, branch: 'main', checkoutBranch: `rac/pr/8/${otherHeadSha.slice(0, 12)}`, checkedOut: false }] });
    await expect(service.switch(agent.id, 8)).resolves.toBe(true);
    expect(calls[0]).toContain("git fetch origin --no-tags --force 'refs/pull/8/head:refs/rac/pull/8'");
    expect(calls[0]).toContain(`test "$(git rev-parse 'refs/rac/pull/8^{commit}')" = '${otherHeadSha}'`);
    expect(calls[0]).toContain(`git switch -c 'rac/pr/8/${otherHeadSha.slice(0, 12)}' --no-track 'refs/rac/pull/8'`);
    expect(calls[0]).not.toContain('origin/main');
  });

  // preserve fork identity independently from author identity
  it('uses the pinned pull request ref for a viewer-authored fork', async () => {
    const forkHeadSha = 'c'.repeat(40);
    const fork = { number: 9, title: 'Viewer fork', branch: 'main', headSha: forkHeadSha, headOnOrigin: false, draft: false, url: 'https://github.com/octo/repo/pull/9' };
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent, { ...agent, id: 'agent-2', branch: 'main' }], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: [fork], others: [] }) };
    const calls: string[] = [];
    const tmux = { suspend: async () => true, input: async (_socket: unknown, _pane: string, command: string) => { calls.push(command); return true; } };
    const service = new PullRequestSwitchService(config, discovery as never, tmux as never, pulls as never, cleanCommand);

    await expect(service.available(agent.id)).resolves.toMatchObject({ pullRequests: [{ number: 9, checkoutBranch: `rac/pr/9/${forkHeadSha.slice(0, 12)}`, checkedOut: false }], otherPullRequests: [] });
    await expect(service.switch(agent.id, 9)).resolves.toBe(true);
    expect(calls[0]).toContain("refs/pull/9/head:refs/rac/pull/9");
    expect(calls[0]).not.toContain('origin/main');
  });

  it('allows switching when HEAD is pushed to a remote branch without a configured upstream', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('for-each-ref')) return { code: 0, stdout: 'refs/remotes/origin/main\n' };
      return { code: 128, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean detached HEAD without requiring a remote ref', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean branch whose configured upstream is gone', async () => {
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
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
    const discovery = { target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('status') ? '' : '' });
    const service = new PullRequestSwitchService(config, discovery as never, {} as never, pulls as never, command);

    await expect(service.available(agent.id)).resolves.toMatchObject({ enabled: false });
  });
});
