import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { run } from '../tmux/command.js';
import { cleanWorkingTree, type GitCommand } from '../git/worktree-state.js';
import { worktreeById, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { agentAttentionState } from '../notifications.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

// bound the local-branch list folded into the availability payload
const maxSwitchableBranches = 200;
// the switch path runs a network `git fetch` in-process; the old pane-driven flow let it run as
// long as it needed, so bound it generously rather than at run's 5s default. Local ops finish well
// under this; the ceiling only keeps a hung fetch from wedging the mutation lock indefinitely.
const gitCommandTimeoutMs = 120_000;
const runGit: GitCommand = (binary, args) => run(binary, args, undefined, gitCommandTimeoutMs);

export type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
export type SwitchablePullRequest = PullRequestChoice & { checkoutBranch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type SwitchableBranch = { branch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[]; branches: SwitchableBranch[]; pullRequestsSupported: boolean };
export type PullRequestMoveResult = 'moved' | 'unavailable' | 'recovery-required' | 'busy';
// a branch/PR checkout outcome; 'busy' means an involved agent is working and, with job
// control gone, cannot be interrupted for the checkout
export type BranchSwitchResult = 'switched' | 'unavailable' | 'busy';
type GitHead = { branch?: string; commit: string };
type SwitchTarget = NonNullable<Awaited<ReturnType<DiscoveryService['target']>>>;

export class PullRequestSwitchService {
  private branchMutationInProgress = false;

  // switch and move run git in-process and never touch a pane, so the service takes no tmux
  // adapter: it is structurally unable to type into an agent's terminal.
  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly pullRequests = new PullRequestService(), private readonly command: GitCommand = runGit) {}

  // list one agent's switchable pull requests and local branches
  async available(agentId: string): Promise<PullRequestSwitchAvailability | undefined> {
    const target = await this.discovery.target(agentId);
    // require one current target
    if (target === undefined) return undefined;
    const worktree = this.worktree(target.agent.home);
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
      const candidate = this.worktree(agent.home)?.identity ?? agent.home;
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
    const enabled = await this.switchReady(worktree);
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
    const worktree = this.worktree(target.agent.home);
    return await this.pullRequests.actionsUrl(worktree?.identity ?? target.agent.home);
  }

  async switch(agentId: string, number: number): Promise<BranchSwitchResult> {
    // reject invalid or concurrent branch mutations
    if (!Number.isInteger(number) || number < 1 || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      const pullRequest = available?.pullRequests.find(candidate => candidate.number === number) ?? available?.otherPullRequests.find(candidate => candidate.number === number);
      const target = await this.discovery.target(agentId);
      const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.home);
      // require one ready and unused target
      if (!available?.enabled || pullRequest === undefined || pullRequest.checkedOut || target === undefined || targetWorktree === undefined) return 'unavailable';
      return await this.runSwitch(target, targetWorktree, pullRequest.checkoutBranch, workspace =>
        pullRequest.headOnOrigin ? this.switchBranchRef(workspace, pullRequest) : this.switchPullRequestRef(workspace, pullRequest));
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // switch to one available local branch open in no other worktree
  async switchBranch(agentId: string, branch: string): Promise<BranchSwitchResult> {
    // reject an empty or concurrent branch mutation
    if (typeof branch !== 'string' || branch === '' || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(agentId);
      // require the branch on the availability list, held by no other worktree
      const switchable = available?.branches.find(candidate => candidate.branch === branch);
      const target = await this.discovery.target(agentId);
      const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.home);
      if (!available?.enabled || switchable === undefined || switchable.checkedOut || target === undefined || targetWorktree === undefined) return 'unavailable';
      return await this.runSwitch(target, targetWorktree, branch, workspace => this.switchLocalBranch(workspace, branch));
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // run one branch-changing git transaction in-process, gated on an idle agent
  private async runSwitch(target: SwitchTarget, targetWorktree: Worktree, checkoutBranch: string, perform: (workspace: string) => Promise<boolean>): Promise<BranchSwitchResult> {
    // without job control a working agent cannot be interrupted for a checkout
    if (agentAttentionState(target.agent) === 'working') return 'busy';
    const currentBranch = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // reject a no-op switch onto the branch already checked out
    if (currentBranch.code === 0 && currentBranch.stdout.trim() === checkoutBranch) return 'unavailable';
    // a failed fetch or switch leaves the current branch untouched, so nothing to roll back
    if (!await perform(targetWorktree.identity)) return 'unavailable';
    // verify HEAD reached the requested branch before reporting success
    const head = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    return head.code === 0 && head.stdout.trim() === checkoutBranch ? 'switched' : 'unavailable';
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

  // switch/move readiness: a clean working tree, whether or not the branch is pushed
  private async switchReady(worktree: Worktree): Promise<boolean> {
    return await cleanWorkingTree(worktree.identity, this.command);
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

  // transfer one checked-out branch and its working state, in-process, gated on idle agents
  private async moveCheckedOutBranch(agentId: string, enabled: boolean, movable: SwitchableBranch): Promise<PullRequestMoveResult> {
    const { branch: checkoutBranch, checkedOut, openIn } = movable;
    const target = await this.discovery.target(agentId);
    const targetWorktree = target === undefined ? undefined : this.worktree(target.agent.home);
    const sourceWorktree = openIn === undefined ? undefined : worktreeById(this.discovery.worktreesNow(), openIn.worktreeId);
    // require one ready destination and one resolvable source
    if (!enabled || !checkedOut || target === undefined || targetWorktree === undefined || openIn === undefined || sourceWorktree === undefined || sourceWorktree.id === targetWorktree.id) return 'unavailable';
    const sourceTarget = openIn.agentId === undefined ? undefined : await this.discovery.target(openIn.agentId);
    // fail closed when the active source changed identity
    if (openIn.agentId !== undefined && (sourceTarget === undefined || sourceTarget.agent.id === target.agent.id || this.worktree(sourceTarget.agent.home)?.id !== sourceWorktree.id)) return 'unavailable';
    // without job control neither the destination nor an active source can be interrupted for a move
    if (agentAttentionState(target.agent) === 'working' || (sourceTarget !== undefined && agentAttentionState(sourceTarget.agent) === 'working')) return 'busy';
    const sourceBranch = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // revalidate the occupied branch immediately before mutation
    if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== checkoutBranch) return 'unavailable';
    try {
      return await this.performMove(sourceWorktree, targetWorktree, checkoutBranch);
    } catch {
      return 'recovery-required';
    }
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
    if (!await this.switchReady(targetWorktree)) return 'unavailable';
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
  private async switchLocalBranch(workspace: string, branch: string): Promise<boolean> {
    const switched = await this.command('/usr/bin/git', ['-C', workspace, 'switch', '--', branch]);
    return switched.code === 0;
  }

  // fetch one SHA-pinned origin branch and check out its tracking local branch
  private async switchBranchRef(workspace: string, pullRequest: SwitchablePullRequest): Promise<boolean> {
    const fetchedRef = `refs/remotes/origin/${pullRequest.branch}`;
    return await this.fetchAndSwitch(workspace, `refs/heads/${pullRequest.branch}:${fetchedRef}`, fetchedRef, pullRequest.headSha, pullRequest.branch, ['--track', fetchedRef]);
  }

  // fetch one SHA-pinned GitHub pull request ref and check out its local branch
  private async switchPullRequestRef(workspace: string, pullRequest: SwitchablePullRequest): Promise<boolean> {
    const fetchedRef = `refs/rac/pull/${pullRequest.number}`;
    return await this.fetchAndSwitch(workspace, `refs/pull/${pullRequest.number}/head:${fetchedRef}`, fetchedRef, pullRequest.headSha, pullRequest.checkoutBranch, ['--no-track', fetchedRef]);
  }

  // fetch a pinned ref, verify it is the reviewed head, then switch to its local branch, creating it when absent
  private async fetchAndSwitch(workspace: string, fetchSpec: string, fetchedRef: string, headSha: string, localBranch: string, createArgs: string[]): Promise<boolean> {
    const fetched = await this.command('/usr/bin/git', ['-C', workspace, 'fetch', 'origin', '--no-tags', '--force', fetchSpec]);
    if (fetched.code !== 0) return false;
    // require the fetched ref to pin the exact reviewed head before mutating the checkout
    if (!await this.commitMatches(workspace, `${fetchedRef}^{commit}`, headSha)) return false;
    const existing = await this.command('/usr/bin/git', ['-C', workspace, 'show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    if (existing.code === 0) {
      // reuse an existing local branch only when it already matches the reviewed head
      if (!await this.commitMatches(workspace, `refs/heads/${localBranch}^{commit}`, headSha)) return false;
      const switched = await this.command('/usr/bin/git', ['-C', workspace, 'switch', '--', localBranch]);
      return switched.code === 0;
    }
    const created = await this.command('/usr/bin/git', ['-C', workspace, 'switch', '-c', localBranch, ...createArgs]);
    return created.code === 0;
  }

  // whether one revision resolves to the exact commit
  private async commitMatches(workspace: string, revision: string, sha: string): Promise<boolean> {
    const resolved = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', revision]);
    return resolved.code === 0 && resolved.stdout.trim() === sha;
  }
}
