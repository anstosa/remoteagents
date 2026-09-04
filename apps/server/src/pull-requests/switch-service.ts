import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { run } from '../tmux/command.js';
import { cleanAndPushedOrDetached, type GitCommand } from '../git/worktree-state.js';
import { worktreeById, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const switchPollDelayMs = 200;
// bound the local-branch list folded into the availability payload
const maxSwitchableBranches = 200;
// wait between completion marker polls
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
export type SwitchablePullRequest = PullRequestChoice & { checkoutBranch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type SwitchableBranch = { branch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[]; branches: SwitchableBranch[]; pullRequestsSupported: boolean };
export type PullRequestMoveResult = 'moved' | 'unavailable' | 'recovery-required';
type GitHead = { branch?: string; commit: string };
type SwitchTarget = NonNullable<Awaited<ReturnType<DiscoveryService['target']>>>;

export class PullRequestSwitchService {
  private branchMutationInProgress = false;

  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly pullRequests = new PullRequestService(), private readonly command: GitCommand = run) {}

  // list one agent's switchable pull requests and local branches
  async available(agentId: string): Promise<PullRequestSwitchAvailability | undefined> {
    const target = await this.discovery.target(agentId);
    // require one current target
    if (target === undefined) return undefined;
    const worktree = this.worktree(target.agent.workspace);
    if (worktree === undefined) return undefined;
    // require one canonical repository identity, not merely a GitHub origin
    const repository = await this.repositoryIdentity(worktree.identity);
    if (repository === undefined) return undefined;
    const dashboard = await this.discovery.dashboard().catch(() => undefined);
    const checkedOut = new Map<string, PullRequestWorktree | undefined>();
    const head = await this.command('/usr/bin/git', ['-C', worktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const currentBranch = head.code === 0 ? head.stdout.trim() : '';
    // prefer the live destination branch over cached dashboard metadata
    if (currentBranch) checkedOut.set(currentBranch, { agentId: target.agent.id, worktreeId: worktree.id, worktreeName: worktree.label });
    const agents = await Promise.all((dashboard?.agents ?? []).map(async agent => {
      // skip the freshly resolved target and branchless agents
      if (agent.id === target.agent.id || agent.branch === undefined) return undefined;
      const candidate = this.worktree(agent.workspace)?.identity ?? agent.workspace;
      return await this.repositoryIdentity(candidate) === repository ? agent : undefined;
    }));
    // prioritize active agents in this repository
    for (const agent of agents) {
      if (agent === undefined || agent.branch === undefined || checkedOut.has(agent.branch)) continue;
      const worktreeName = agent.worktreeId === undefined ? undefined : worktreeById(this.discovery.worktreesNow(), agent.worktreeId)?.label;
      checkedOut.set(agent.branch, agent.worktreeId === undefined || worktreeName === undefined ? undefined : { agentId: agent.id, worktreeId: agent.worktreeId, worktreeName });
    }
    const worktrees = await Promise.all((dashboard?.projects.flatMap(project => project.worktrees) ?? []).map(async candidate => {
      // ignore branchless worktrees; every dashboard Worktree is a real discovered checkout
      if (candidate.branch === undefined) return undefined;
      return await this.repositoryIdentity(candidate.path) === repository ? candidate : undefined;
    }));
    // fill inactive worktrees after active agents
    for (const candidate of worktrees) {
      if (candidate === undefined || candidate.branch === undefined || checkedOut.has(candidate.branch)) continue;
      checkedOut.set(candidate.branch, { worktreeId: candidate.id, worktreeName: candidate.label });
    }
    // list pull requests only for a supported GitHub origin
    const pullRequestsSupported = await this.pullRequests.supports(worktree.identity);
    // load slow remote metadata before taking the readiness snapshot
    const pullRequests = pullRequestsSupported ? await this.pullRequests.open(worktree.identity) : { own: [], others: [] };
    // reflect git changes completed while GitHub was loading
    const enabled = await this.cleanAndPushed(worktree);
    // apply worktree availability around each checkout branch
    const switchable = (choices: PullRequestChoice[]): SwitchablePullRequest[] => choices.map(pullRequest => {
      const branch = pullRequest.headOnOrigin ? pullRequest.branch : this.pullRequestBranch(pullRequest);
      return { ...pullRequest, checkoutBranch: branch, ...this.checkoutAnnotation(branch, checkedOut) };
    });
    const own = switchable(pullRequests.own);
    const others = switchable(pullRequests.others);
    const branches = await this.localBranches(worktree.identity, checkedOut, currentBranch, new Set([...own, ...others].map(pullRequest => pullRequest.checkoutBranch)));
    return { enabled, pullRequests: own, otherPullRequests: others, branches, pullRequestsSupported };
  }

  // annotate one branch with the worktree that currently holds it
  private checkoutAnnotation(branch: string, checkedOut: Map<string, PullRequestWorktree | undefined>): { checkedOut: boolean; openIn?: PullRequestWorktree } {
    const openIn = checkedOut.get(branch);
    return { checkedOut: checkedOut.has(branch), ...(openIn === undefined ? {} : { openIn }) };
  }

  // list local branches outside the current branch and the shown pull requests, bounded for very large repositories
  private async localBranches(workspace: string, checkedOut: Map<string, PullRequestWorktree | undefined>, currentBranch: string, pullRequestBranches: Set<string>): Promise<SwitchableBranch[]> {
    const listed = await this.command('/usr/bin/git', ['-C', workspace, 'for-each-ref', 'refs/heads', '--format=%(refname:short)']);
    // omit branches when the listing fails
    if (listed.code !== 0) return [];
    const branches: SwitchableBranch[] = [];
    for (const line of listed.stdout.split('\n')) {
      const branch = line.trim();
      // skip the current branch and any branch already offered as a pull request
      if (branch === '' || branch === currentBranch || pullRequestBranches.has(branch)) continue;
      branches.push({ branch, ...this.checkoutAnnotation(branch, checkedOut) });
      // cap the payload for repositories with very many local branches
      if (branches.length >= maxSwitchableBranches) break;
    }
    return branches;
  }

  async actionsUrl(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const worktree = this.worktree(target.agent.workspace);
    return await this.pullRequests.actionsUrl(worktree?.identity ?? target.agent.workspace);
  }

  async switch(agentId: string, number: number): Promise<boolean> {
    // reject invalid or concurrent branch mutations
    if (!Number.isInteger(number) || number < 1 || this.branchMutationInProgress) return false;
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      const pullRequest = available?.pullRequests.find(candidate => candidate.number === number) ?? available?.otherPullRequests.find(candidate => candidate.number === number);
      const target = await this.discovery.target(agentId);
      const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
      // require one ready and unused target
      if (!available?.enabled || pullRequest === undefined || pullRequest.checkedOut || target === undefined || targetWorktree === undefined) return false;
      const switchCommand = pullRequest.headOnOrigin ? this.branchSwitchCommand(pullRequest) : this.pullRequestSwitchCommand(pullRequest);
      return await this.runSwitch(target, targetWorktree, pullRequest.checkoutBranch, switchCommand);
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // switch to one available local branch open in no other worktree
  async switchBranch(agentId: string, branch: string): Promise<boolean> {
    // reject an empty or concurrent branch mutation
    if (typeof branch !== 'string' || branch === '' || this.branchMutationInProgress) return false;
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      // require the branch on the availability list, held by no other worktree
      const switchable = available?.branches.find(candidate => candidate.branch === branch);
      const target = await this.discovery.target(agentId);
      const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
      if (!available?.enabled || switchable === undefined || switchable.checkedOut || target === undefined || targetWorktree === undefined) return false;
      return await this.runSwitch(target, targetWorktree, branch, this.plainSwitchCommand(branch));
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // suspend the pane, inject one branch-changing command, and await its completion
  private async runSwitch(target: SwitchTarget, targetWorktree: Worktree, checkoutBranch: string, switchCommand: string): Promise<boolean> {
    const currentBranch = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // reject a no-op switch that cannot prove command completion
    if (currentBranch.code === 0 && currentBranch.stdout.trim() === checkoutBranch) return false;
    const completionPath = `/tmp/rac-switch-${randomUUID()}`;
    const temporaryCompletionPath = `${completionPath}.tmp`;
    const recordCompletion = `rac_switch_status=$?; trap - EXIT HUP INT TERM; printf '%s\\n' "$rac_switch_status" > ${quote(temporaryCompletionPath)} && mv -- ${quote(temporaryCompletionPath)} ${quote(completionPath)}; exit "$rac_switch_status"`;
    const command = `/bin/sh -c ${quote(`trap ${quote(recordCompletion)} EXIT HUP INT TERM; ${switchCommand}`)}; clear; fg`;
    // suspend before handing the pane to Git
    if (!await this.tmux.suspend(target.socket, target.agent.paneId)) return false;
    const accepted = await this.tmux.input(target.socket, target.agent.paneId, `\x15${command}\r`);
    // resume after failed input delivery
    if (!accepted) {
      await this.command('/usr/bin/rm', ['-f', '--', temporaryCompletionPath, completionPath]);
      await this.tmux.foreground(target.socket, target.agent.paneId);
      return false;
    }
    return await this.waitForSwitchCompletion(completionPath, targetWorktree.identity, checkoutBranch);
  }

  // move one occupied pull request into the requested worktree
  async move(agentId: string, number: number): Promise<PullRequestMoveResult> {
    // reject invalid or concurrent move requests
    if (!Number.isInteger(number) || number < 1 || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      const pullRequest = [...(available?.pullRequests ?? []), ...(available?.otherPullRequests ?? [])].find(candidate => candidate.number === number);
      if (available === undefined || pullRequest === undefined) return 'unavailable';
      return await this.moveCheckedOutBranch(agentId, available.enabled, { branch: pullRequest.checkoutBranch, checkedOut: pullRequest.checkedOut, openIn: pullRequest.openIn });
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // move one occupied local branch into the requested worktree
  async moveBranch(agentId: string, branch: string): Promise<PullRequestMoveResult> {
    // reject an empty or concurrent move request
    if (typeof branch !== 'string' || branch === '' || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      const switchable = available?.branches.find(candidate => candidate.branch === branch);
      if (available === undefined || switchable === undefined) return 'unavailable';
      return await this.moveCheckedOutBranch(agentId, available.enabled, switchable);
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.discovery.worktreesNow().find(worktree => worktreeMatchesWorkspace(worktree, workspace));
  }

  private async cleanAndPushed(worktree: Worktree): Promise<boolean> {
    return await cleanAndPushedOrDetached(worktree.identity, this.command);
  }

  // resolve one linked-worktree repository identity
  private async repositoryIdentity(workspace: string): Promise<string | undefined> {
    const repository = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const path = repository.stdout.trim();
    // reject unreadable repository metadata
    if (repository.code !== 0 || !path.startsWith('/')) return undefined;
    try {
      const info = await stat(path, { bigint: true });
      return `inode:${info.dev}:${info.ino}`;
    } catch {
      // retain deterministic command-test identities
      return `path:${path}`;
    }
  }

  // hold the mutation lock until one submitted pane command finishes
  private async waitForSwitchCompletion(completionPath: string, workspace: string, branch: string): Promise<boolean> {
    // wait through slow or interactively interrupted fetches
    for (;;) {
      const completion = await this.command('/usr/bin/cat', [completionPath]);
      // verify the final branch only after the shell records completion
      if (completion.code === 0) {
        await this.command('/usr/bin/rm', ['-f', '--', completionPath]);
        if (completion.stdout.trim() !== '0') return false;
        const current = await this.command('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
        return current.code === 0 && current.stdout.trim() === branch;
      }
      await delay(switchPollDelayMs);
    }
  }

  // transfer one checked-out branch and its working state
  private async moveCheckedOutBranch(agentId: string, enabled: boolean, movable: SwitchableBranch): Promise<PullRequestMoveResult> {
    const { branch: checkoutBranch, checkedOut, openIn } = movable;
    const target = await this.discovery.target(agentId);
    const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
    const sourceWorktree = openIn === undefined ? undefined : worktreeById(this.discovery.worktreesNow(), openIn.worktreeId);
    // require one ready destination and one resolvable source
    if (!enabled || !checkedOut || target === undefined || targetWorktree === undefined || openIn === undefined || sourceWorktree === undefined || sourceWorktree.id === targetWorktree.id) return 'unavailable';
    const sourceTarget = openIn.agentId === undefined ? undefined : await this.discovery.target(openIn.agentId);
    // fail closed when the active source changed identity
    if (openIn.agentId !== undefined && (sourceTarget === undefined || sourceTarget.agent.id === target.agent.id || this.worktree(sourceTarget.agent.workspace)?.id !== sourceWorktree.id)) return 'unavailable';
    const sourceBranch = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // revalidate the occupied branch immediately before mutation
    if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== checkoutBranch) return 'unavailable';

    let sourceSuspended = sourceTarget === undefined;
    // pause the source agent before moving its working copy
    if (sourceTarget !== undefined) sourceSuspended = await this.tmux.suspend(sourceTarget.socket, sourceTarget.agent.paneId);
    if (!sourceSuspended) return 'unavailable';
    const targetSuspended = await this.tmux.suspend(target.socket, target.agent.paneId);
    // resume the source when the destination cannot pause
    if (!targetSuspended) {
      const sourceResumed = sourceTarget === undefined || await this.tmux.foreground(sourceTarget.socket, sourceTarget.agent.paneId);
      return sourceResumed ? 'unavailable' : 'recovery-required';
    }

    let result: PullRequestMoveResult = 'recovery-required';
    try {
      result = await this.performMove(sourceWorktree, targetWorktree, checkoutBranch);
    } catch {
      result = 'recovery-required';
    }
    const sourceResumed = sourceTarget === undefined || await this.tmux.foreground(sourceTarget.socket, sourceTarget.agent.paneId);
    const targetResumed = await this.tmux.foreground(target.socket, target.agent.paneId);
    // expose stopped agents as a recovery-required partial result
    if (!sourceResumed || !targetResumed) return 'recovery-required';
    return result;
  }

  // execute the git transaction after both agents pause
  private async performMove(sourceWorktree: Worktree, targetWorktree: Worktree, checkoutBranch: string): Promise<PullRequestMoveResult> {
    const [sourceRepository, targetRepository] = await Promise.all([this.repositoryIdentity(sourceWorktree.identity), this.repositoryIdentity(targetWorktree.identity)]);
    // prevent branch-name collisions across repositories
    if (sourceRepository === undefined || sourceRepository !== targetRepository) return 'unavailable';
    const sourceBranch = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // close the source branch race after suspension
    if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== checkoutBranch) return 'unavailable';
    // close the destination readiness race after suspension
    if (!await this.cleanAndPushed(targetWorktree)) return 'unavailable';
    const targetHead = await this.gitHead(targetWorktree.identity);
    // preserve an exact destination rollback point
    if (targetHead === undefined) return 'unavailable';

    const sourceStatus = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
    // refuse unreadable source state
    if (sourceStatus.code !== 0) return 'unavailable';
    let stashOid: string | undefined;
    // capture all tracked and untracked source changes
    if (sourceStatus.stdout.trim()) {
      const stashMessage = `rac move ${randomUUID()} ${checkoutBranch}`;
      const stashed = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'stash', 'push', '--include-untracked', '--message', stashMessage]);
      if (stashed.code !== 0) return 'unavailable';
      const stashes = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'stash', 'list', '--format=%H%x09%gs']);
      const matching = stashes.stdout.split('\n').map(line => line.split('\t')).find(([, subject]) => subject?.endsWith(stashMessage));
      // identify only the uniquely named stash created by this move
      if (stashes.code !== 0 || matching === undefined || !/^[0-9a-f]{40}$/u.test(matching[0] ?? '')) {
        const afterStash = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
        // distinguish a no-op stash from hidden changes
        return afterStash.code === 0 && afterStash.stdout === sourceStatus.stdout ? 'unavailable' : 'recovery-required';
      }
      stashOid = matching[0];
      const cleanSource = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
      // restore the stash if unsupported source state remains
      if (cleanSource.code !== 0 || cleanSource.stdout.trim()) return await this.applyAndDropStash(sourceWorktree.identity, stashOid) ? 'unavailable' : 'recovery-required';
    }

    const detached = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'switch', '--detach']);
    // restore source changes when detaching fails
    if (detached.code !== 0) {
      if (stashOid === undefined) return 'unavailable';
      return await this.applyAndDropStash(sourceWorktree.identity, stashOid) ? 'unavailable' : 'recovery-required';
    }
    const switched = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'switch', '--', checkoutBranch]);
    // roll back both worktrees when checkout fails
    if (switched.code !== 0) {
      return await this.rollbackMove(sourceWorktree, targetWorktree, checkoutBranch, targetHead, stashOid, false) ? 'unavailable' : 'recovery-required';
    }
    // recover the source index and working tree at the destination
    if (stashOid !== undefined && !await this.applyAndDropStash(targetWorktree.identity, stashOid)) {
      return await this.rollbackMove(sourceWorktree, targetWorktree, checkoutBranch, targetHead, stashOid, true) ? 'unavailable' : 'recovery-required';
    }
    return 'moved';
  }
  // capture one branch or detached rollback point
  private async gitHead(workspace: string): Promise<GitHead | undefined> {
    const branch = await this.command('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const commit = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD^{commit}']);
    // require a concrete current commit
    if (commit.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit.stdout.trim())) return undefined;
    return { ...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}), commit: commit.stdout.trim() };
  }

  // apply one exact stash and remove only its matching entry
  private async applyAndDropStash(workspace: string, oid: string): Promise<boolean> {
    const applied = await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'apply', '--index', oid]);
    // retain the stash for manual recovery after conflicts
    if (applied.code !== 0) return false;
    const list = await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'list', '--format=%gd%x09%H']);
    // keep successful recovery even if stash cleanup is unavailable
    if (list.code !== 0) return true;
    const matching = list.stdout.split('\n').map(line => line.split('\t')).find(([, hash]) => hash === oid)?.[0];
    // drop only the exact recovered stash
    if (matching !== undefined) await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'drop', matching]);
    return true;
  }

  // restore both worktrees after a failed destination change
  private async rollbackMove(source: Worktree, target: Worktree, branch: string, targetHead: GitHead, stashOid: string | undefined, cleanTarget: boolean): Promise<boolean> {
    let recovered = true;
    // discard only changes introduced by a failed stash apply
    if (cleanTarget) {
      const reset = await this.command('/usr/bin/git', ['-C', target.identity, 'reset', '--hard', 'HEAD']);
      const cleaned = await this.command('/usr/bin/git', ['-C', target.identity, 'clean', '-fd']);
      recovered = reset.code === 0 && cleaned.code === 0;
    }
    const restoreTarget = targetHead.branch === undefined
      ? ['-C', target.identity, 'switch', '--detach', targetHead.commit]
      : ['-C', target.identity, 'switch', '--', targetHead.branch];
    const restoredTarget = await this.command('/usr/bin/git', restoreTarget);
    recovered = restoredTarget.code === 0 && recovered;
    const restoredSource = await this.command('/usr/bin/git', ['-C', source.identity, 'switch', '--', branch]);
    // recover source changes only after its branch returns
    recovered = restoredSource.code === 0 && recovered;
    if (restoredSource.code === 0 && stashOid !== undefined) recovered = await this.applyAndDropStash(source.identity, stashOid) && recovered;
    const currentTarget = await this.gitHead(target.identity);
    const currentSource = await this.command('/usr/bin/git', ['-C', source.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const targetStatus = await this.command('/usr/bin/git', ['-C', target.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
    // verify both branch coordinates after best-effort rollback
    return recovered && currentTarget?.commit === targetHead.commit && currentTarget.branch === targetHead.branch && currentSource.code === 0 && currentSource.stdout.trim() === branch && targetStatus.code === 0 && !targetStatus.stdout.trim();
  }

  // derive one app-owned local branch
  private pullRequestBranch(pullRequest: PullRequestChoice): string { return `rac/pr/${pullRequest.number}/${pullRequest.headSha.slice(0, 12)}`; }

  // switch one existing local branch without touching origin
  private plainSwitchCommand(branch: string): string { return `git switch -- ${quote(branch)}`; }

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
