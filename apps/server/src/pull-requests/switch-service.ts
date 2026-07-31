import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { run } from '../tmux/command.js';
import { cleanAndPushedOrDetached, type GitCommand } from '../git/worktree-state.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
export type SwitchablePullRequest = PullRequestChoice & { checkedOut: boolean; openIn?: PullRequestWorktree };
export type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[] };

export class PullRequestSwitchService {
  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly pullRequests = new PullRequestService(), private readonly command: GitCommand = run) {}

  async available(agentId: string): Promise<PullRequestSwitchAvailability | undefined> {
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
    if (worktree === undefined || !await this.pullRequests.supports(worktree.identity)) return undefined;
    const [enabled, pullRequests, dashboard] = await Promise.all([
      this.cleanAndPushed(worktree),
      this.pullRequests.ownOpen(worktree.identity),
      this.discovery.dashboard(this.config.worktrees).catch(() => undefined)
    ]);
    const checkedOut = new Map<string, PullRequestWorktree | undefined>();
    for (const agent of dashboard?.agents ?? []) {
      if (agent.id === agentId || agent.branch === undefined) continue;
      checkedOut.set(agent.branch, agent.worktreeId === undefined || agent.worktreeLabel === undefined ? undefined : { agentId: agent.id, worktreeId: agent.worktreeId, worktreeName: agent.worktreeLabel });
    }
    for (const candidate of dashboard?.worktrees ?? []) {
      if (candidate.branch === undefined || checkedOut.has(candidate.branch)) continue;
      checkedOut.set(candidate.branch, { worktreeId: candidate.id, worktreeName: candidate.label });
    }
    return {
      enabled,
      pullRequests: (pullRequests ?? []).map(pullRequest => {
        const openIn = checkedOut.get(pullRequest.branch);
        return { ...pullRequest, checkedOut: checkedOut.has(pullRequest.branch), ...(openIn === undefined ? {} : { openIn }) };
      })
    };
  }

  async switch(agentId: string, number: number): Promise<boolean> {
    if (!Number.isInteger(number) || number < 1) return false;
    const available = await this.available(agentId);
    const pullRequest = available?.pullRequests.find(candidate => candidate.number === number);
    const target = await this.discovery.target(agentId);
    if (!available?.enabled || pullRequest === undefined || pullRequest.checkedOut || target === undefined) return false;
    const command = `${this.switchCommand(pullRequest.branch)}; clear; fg`;
    if (!await this.tmux.suspend(target.socket, target.agent.paneId)) return false;
    return await this.tmux.input(target.socket, target.agent.paneId, `\x15${command}\r`);
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.config.worktrees.find(worktree => workspace === worktree.identity || workspace === worktree.hostPath);
  }

  private async cleanAndPushed(worktree: Worktree): Promise<boolean> {
    return await cleanAndPushedOrDetached(worktree.identity, this.command);
  }

  private switchCommand(branch: string): string {
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `origin/${branch}`;
    return `git fetch origin -- ${quote(branch)} && if git show-ref --verify --quiet ${quote(localRef)}; then git switch -- ${quote(branch)}; else git switch -c ${quote(branch)} --track ${quote(remoteRef)}; fi`;
  }
}
