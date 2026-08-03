import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import type { PullRequestCheckStatus, PullRequestIssues, PullRequestSummary } from '../domain/models.js';

type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type ResponseLike = { ok: boolean; json(): Promise<unknown> };
type Request = (input: string, init?: RequestInit) => Promise<ResponseLike>;
type Token = () => Promise<string | undefined>;

type GithubRepository = { owner: string; name: string };
type PullRequestCandidate = PullRequestSummary & { headSha?: string };
type PullRequestChoiceCandidate = PullRequestChoice & { headSha?: string };
export type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
const cacheTtlMs = 60_000;
const failingCheckConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

export function githubRepository(remote: string): GithubRepository | undefined {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match === null ? undefined : { owner: match[1]!, name: match[2]! };
}

async function githubToken(): Promise<string | undefined> {
  if (process.env.RAC_GITHUB_TOKEN) return process.env.RAC_GITHUB_TOKEN;
  const hosts = await readFile(process.env.RAC_GH_HOSTS ?? join(homedir(), '.config/gh/hosts.yml'), 'utf8').catch(() => '');
  return /^\s+oauth_token:\s*(\S+)\s*$/m.exec(hosts)?.[1];
}

export class PullRequestService {
  private readonly cache = new Map<string, { expiresAt: number; value?: PullRequestSummary; pending?: Promise<PullRequestSummary | undefined> }>();
  private token?: Promise<string | undefined>;
  private viewer?: Promise<string | undefined>;

  constructor(private readonly command: Command = run, private readonly request: Request = fetch, private readonly now: () => number = Date.now, private readonly getToken: Token = githubToken) {}

  async url(workspace: string, branch?: string): Promise<string | undefined> {
    const cached = await this.lookupCached(workspace, branch);
    return (cached?.pending === undefined ? cached?.value : await cached.pending)?.url;
  }

  async ownOpen(workspace: string): Promise<PullRequestChoice[] | undefined> {
    const repository = await this.repository(workspace);
    if (repository === undefined) return undefined;
    this.token ??= this.getToken();
    const token = await this.token;
    if (token === undefined) return undefined;
    this.viewer ??= this.viewerLogin(token);
    const viewer = await this.viewer;
    if (viewer === undefined) return undefined;
    const query = new URLSearchParams({ state: 'open', per_page: '100' });
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    if (!response?.ok) return undefined;
    const pulls = await response.json().catch(() => undefined);
    if (!Array.isArray(pulls)) return undefined;
    const choices = pulls.flatMap((pull): PullRequestChoiceCandidate[] => {
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; html_url?: unknown; user?: { login?: unknown }; head?: { ref?: unknown; sha?: unknown } };
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.head?.ref !== 'string' || typeof value.user?.login !== 'string' || value.user.login !== viewer || typeof value.html_url !== 'string') return [];
      try {
        const url = new URL(value.html_url);
        return url.protocol === 'https:' && url.hostname === 'github.com' ? [{ number: value.number as number, title: value.title, branch: value.head.ref, draft: value.draft === true, url: url.href, ...(typeof value.head.sha === 'string' && /^[a-f0-9]{40}$/iu.test(value.head.sha) ? { headSha: value.head.sha } : {}) }] : [];
      } catch { return []; }
    });
    return await Promise.all(choices.map(async ({ headSha, ...choice }) => {
      const { checks, issues } = await this.issueStatus(repository, choice.number, headSha, token);
      return { ...choice, checks, ...(Object.keys(issues).length === 0 ? {} : { issues }) };
    }));
  }

  async supports(workspace: string): Promise<boolean> { return await this.repository(workspace) !== undefined; }

  async actionsUrl(workspace: string): Promise<string | undefined> {
    const repository = await this.repository(workspace);
    return repository === undefined ? undefined : `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions`;
  }

  /**
   * Dashboard rendering must not wait on GitHub. It can use a previous URL,
   * start a refresh when needed, and pick up the result on its next poll.
   */
  async cachedPullRequest(workspace: string, branch?: string): Promise<PullRequestSummary | undefined> {
    return (await this.lookupCached(workspace, branch))?.value;
  }

  private async lookupCached(workspace: string, branch?: string): Promise<{ expiresAt: number; value?: PullRequestSummary; pending?: Promise<PullRequestSummary | undefined> } | undefined> {
    if (!branch) return undefined;
    const repository = await this.repository(workspace);
    if (repository === undefined) return undefined;
    const key = `${repository.owner}/${repository.name}:${branch}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached;
    const pending = this.lookup(repository, branch).catch(() => undefined).then((value) => {
      const refreshed = { expiresAt: this.now() + cacheTtlMs, ...(value === undefined ? {} : { value }) };
      this.cache.set(key, refreshed);
      return value;
    });
    const refreshing = { expiresAt: this.now() + cacheTtlMs, ...(cached?.value === undefined ? {} : { value: cached.value }), pending };
    this.cache.set(key, refreshing);
    return refreshing;
  }

  private async repository(workspace: string): Promise<GithubRepository | undefined> {
    const remote = await this.command('/usr/bin/git', ['-C', workspace, 'remote', 'get-url', 'origin']);
    return remote.code === 0 ? githubRepository(remote.stdout) : undefined;
  }

  private async viewerLogin(token: string): Promise<string | undefined> {
    const response = await this.request('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    if (!response?.ok) return undefined;
    const value = await response.json().catch(() => undefined);
    return value !== null && typeof value === 'object' && typeof (value as { login?: unknown }).login === 'string' ? (value as { login: string }).login : undefined;
  }

  private async lookup(repository: GithubRepository, branch: string): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100' });
    this.token ??= this.getToken();
    const token = await this.token;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const pulls = await response.json().catch(() => undefined);
    if (!Array.isArray(pulls)) return undefined;
    const summaries = pulls.flatMap((pull): PullRequestCandidate[] => {
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; state?: unknown; merged_at?: unknown; html_url?: unknown; head?: { sha?: unknown } };
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.html_url !== 'string') return [];
      const status = typeof value.merged_at === 'string' ? 'merged' : value.state === 'open' ? value.draft === true ? 'draft' : 'open' : undefined;
      if (status === undefined) return [];
      try {
        const url = new URL(value.html_url);
        return url.protocol === 'https:' && url.hostname === 'github.com' ? [{ number: value.number as number, title: value.title, status, url: url.href, ...(typeof value.head?.sha === 'string' && /^[a-f0-9]{40}$/iu.test(value.head.sha) ? { headSha: value.head.sha } : {}) }] : [];
      } catch { return []; }
    });
    const selected = summaries.find(pullRequest => pullRequest.status !== 'merged') ?? summaries[0];
    if (selected === undefined) return undefined;
    const { headSha, ...summary } = selected;
    const { checks, issues } = await this.issueStatus(repository, summary.number, headSha, token);
    return { ...summary, checks, ...(summary.status === 'merged' || Object.keys(issues).length === 0 ? {} : { issues }) };
  }

  private async issueStatus(repository: GithubRepository, number: number, headSha: string | undefined, token: string | undefined): Promise<{ checks: PullRequestCheckStatus; issues: PullRequestIssues }> {
    const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const headers = { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
    const detailRequest = this.request(`${base}/pulls/${number}`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const checksRequest = headSha === undefined ? Promise.resolve(undefined) : this.request(`${base}/commits/${headSha}/check-runs?per_page=100`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const statusRequest = headSha === undefined ? Promise.resolve(undefined) : this.request(`${base}/commits/${headSha}/status`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const reviewRequest = token === undefined ? Promise.resolve(undefined) : this.request('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}',
        variables: { owner: repository.owner, repo: repository.name, number }
      }),
      signal: AbortSignal.timeout(8_000)
    }).catch(() => undefined);
    const [detailResponse, checksResponse, statusResponse, reviewResponse] = await Promise.all([detailRequest, checksRequest, statusRequest, reviewRequest]);
    const [detail, checks, status, reviews] = await Promise.all([
      detailResponse?.ok ? detailResponse.json().catch(() => undefined) : undefined,
      checksResponse?.ok ? checksResponse.json().catch(() => undefined) : undefined,
      statusResponse?.ok ? statusResponse.json().catch(() => undefined) : undefined,
      reviewResponse?.ok ? reviewResponse.json().catch(() => undefined) : undefined
    ]);
    const issues: PullRequestIssues = {};
    if (detail !== null && typeof detail === 'object') {
      const value = detail as { mergeable?: unknown; mergeable_state?: unknown };
      if (value.mergeable === false || value.mergeable_state === 'dirty') issues.mergeConflicts = true;
    }
    const checkRuns = checks !== null && typeof checks === 'object' && Array.isArray((checks as { check_runs?: unknown }).check_runs) ? (checks as { check_runs: unknown[] }).check_runs : undefined;
    const commitStatuses = status !== null && typeof status === 'object' && Array.isArray((status as { statuses?: unknown }).statuses) ? (status as { statuses: unknown[] }).statuses : undefined;
    const hasFailingRun = checkRuns?.some(run => run !== null && typeof run === 'object' && typeof (run as { conclusion?: unknown }).conclusion === 'string' && failingCheckConclusions.has((run as { conclusion: string }).conclusion)) === true;
    const hasFailingStatus = commitStatuses?.some(candidate => candidate !== null && typeof candidate === 'object' && ((candidate as { state?: unknown }).state === 'failure' || (candidate as { state?: unknown }).state === 'error')) === true;
    if (hasFailingRun || hasFailingStatus) issues.failingChecks = true;
    const hasPendingRun = checkRuns?.some(run => {
      if (run === null || typeof run !== 'object') return true;
      const value = run as { status?: unknown; conclusion?: unknown };
      return value.status !== 'completed' || value.conclusion === null || value.conclusion === undefined;
    }) === true;
    const hasPendingStatus = commitStatuses?.some(candidate => candidate === null || typeof candidate !== 'object' || (candidate as { state?: unknown }).state === 'pending') === true;
    const checkStatus: PullRequestCheckStatus = hasFailingRun || hasFailingStatus
      ? 'failed'
      : headSha === undefined || checkRuns === undefined || commitStatuses === undefined || hasPendingRun || hasPendingStatus
        ? 'pending'
        : 'passed';
    const threads = reviews !== null && typeof reviews === 'object' ? (reviews as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } } }).data?.repository?.pullRequest?.reviewThreads?.nodes : undefined;
    if (Array.isArray(threads) && threads.some(thread => thread !== null && typeof thread === 'object' && (thread as { isResolved?: unknown }).isResolved === false && (thread as { isOutdated?: unknown }).isOutdated !== true)) issues.unresolvedComments = true;
    return { checks: checkStatus, issues };
  }
}
