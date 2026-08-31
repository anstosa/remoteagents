import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { run } from '../tmux/command.js';
import { cleanAndPushedOrDetached, type GitCommand } from '../git/worktree-state.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
export type SwitchablePullRequest = PullRequestChoice & { checkoutBranch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[] };

export class PullRequestSwitchService {
  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly pullRequests = new PullRequestService(), private readonly command: GitCommand = run) {}

  // list one agent's switchable pull requests
  async available(agentId: string): Promise<PullRequestSwitchAvailability | undefined> {
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
    if (worktree === undefined || !await this.pullRequests.supports(worktree.identity)) return undefined;
    // load slow remote metadata before taking the readiness snapshot
    const [pullRequests, dashboard] = await Promise.all([
      this.pullRequests.open(worktree.identity),
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
    // reflect git changes completed while GitHub was loading
    const enabled = await this.cleanAndPushed(worktree);
    // apply worktree availability around each checkout branch
    const switchable = (choices: PullRequestChoice[]): SwitchablePullRequest[] => choices.map(pullRequest => {
      const branch = pullRequest.headOnOrigin ? pullRequest.branch : this.pullRequestBranch(pullRequest);
      const openIn = checkedOut.get(branch);
      return { ...pullRequest, checkoutBranch: branch, checkedOut: checkedOut.has(branch), ...(openIn === undefined ? {} : { openIn }) };
    });
    return { enabled, pullRequests: switchable(pullRequests.own), otherPullRequests: switchable(pullRequests.others) };
  }

  async actionsUrl(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const worktree = this.worktree(target.agent.workspace);
    return await this.pullRequests.actionsUrl(worktree?.identity ?? target.agent.workspace);
  }

  async switch(agentId: string, number: number): Promise<boolean> {
    // reject invalid pull request numbers
    if (!Number.isInteger(number) || number < 1) return false;
    const available = await this.available(agentId);
    const ownPullRequest = available?.pullRequests.find(candidate => candidate.number === number);
    const otherPullRequest = available?.otherPullRequests.find(candidate => candidate.number === number);
    const pullRequest = ownPullRequest ?? otherPullRequest;
    const target = await this.discovery.target(agentId);
    // require one ready and unused target
    if (!available?.enabled || pullRequest === undefined || pullRequest.checkedOut || target === undefined) return false;
    const command = `${pullRequest.headOnOrigin ? this.branchSwitchCommand(pullRequest) : this.pullRequestSwitchCommand(pullRequest)}; clear; fg`;
    // suspend before handing the pane to Git
    if (!await this.tmux.suspend(target.socket, target.agent.paneId)) return false;
    return await this.tmux.input(target.socket, target.agent.paneId, `\x15${command}\r`);
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.config.worktrees.find(worktree => workspace === worktree.identity || workspace === worktree.hostPath);
  }

  private async cleanAndPushed(worktree: Worktree): Promise<boolean> {
    return await cleanAndPushedOrDetached(worktree.identity, this.command);
  }

  // derive one app-owned local branch
  private pullRequestBranch(pullRequest: PullRequestChoice): string { return `rac/pr/${pullRequest.number}/${pullRequest.headSha.slice(0, 12)}`; }

  // switch one SHA-pinned origin branch
  private branchSwitchCommand(pullRequest: SwitchablePullRequest): string {
    const localRef = `refs/heads/${pullRequest.branch}`;
    const fetchedRef = `refs/remotes/origin/${pullRequest.branch}`;
    const fetchSpec = `refs/heads/${pullRequest.branch}:${fetchedRef}`;
    const fetchedCommit = `${fetchedRef}^{commit}`;
    const localCommit = `${localRef}^{commit}`;
    return `git fetch origin --no-tags --force ${quote(fetchSpec)} && test "$(git rev-parse ${quote(fetchedCommit)})" = ${quote(pullRequest.headSha)} && if git show-ref --verify --quiet ${quote(localRef)}; then test "$(git rev-parse ${quote(localCommit)})" = ${quote(pullRequest.headSha)} && git switch -- ${quote(pullRequest.branch)}; else git switch -c ${quote(pullRequest.branch)} --track ${quote(fetchedRef)}; fi`;
  }

  // switch one SHA-pinned GitHub pull request ref
  private pullRequestSwitchCommand(pullRequest: SwitchablePullRequest): string {
    const fetchedRef = `refs/rac/pull/${pullRequest.number}`;
    const fetchSpec = `refs/pull/${pullRequest.number}/head:${fetchedRef}`;
    const fetchedCommit = `${fetchedRef}^{commit}`;
    const localRef = `refs/heads/${pullRequest.checkoutBranch}`;
    const localCommit = `${localRef}^{commit}`;
    return `git fetch origin --no-tags --force ${quote(fetchSpec)} && test "$(git rev-parse ${quote(fetchedCommit)})" = ${quote(pullRequest.headSha)} && if git show-ref --verify --quiet ${quote(localRef)}; then test "$(git rev-parse ${quote(localCommit)})" = ${quote(pullRequest.headSha)} && git switch -- ${quote(pullRequest.checkoutBranch)}; else git switch -c ${quote(pullRequest.checkoutBranch)} --no-track ${quote(fetchedRef)}; fi`;
  }
}
