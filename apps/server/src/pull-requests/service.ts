import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import type { PullRequestCheckStatus, PullRequestIssues, PullRequestSummary } from '../domain/models.js';

type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type ResponseLike = { ok: boolean; status?: number; json(): Promise<unknown> };
type Request = (input: string, init?: RequestInit) => Promise<ResponseLike>;
type Token = () => Promise<string | undefined>;

type GithubRepository = { owner: string; name: string };
type PullRequestCandidate = PullRequestSummary & { headSha?: string };
type PullRequestChoiceCandidate = PullRequestChoice & { ownedByViewer: boolean };
export type PullRequestChoice = { number: number; title: string; branch: string; headSha: string; headOnOrigin: boolean; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export type OpenPullRequestChoices = { own: PullRequestChoice[]; others: PullRequestChoice[] };
const cacheTtlMs = 60_000;
const githubRequestAttempts = 3;
const failingCheckConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const retryableGithubStatuses = new Set([500, 502, 503, 504]);

export class PullRequestLookupError extends Error {
  // expose a safe gateway status
  constructor(message: string, readonly statusCode = 502, readonly githubStatus?: number) {
    super(message);
    this.name = 'PullRequestLookupError';
  }
}

// read one bounded GitHub error message
function githubErrorMessage(value: unknown): string | undefined {
  const message = value !== null && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string' ? (value as { message: string }).message.trim().replace(/\s+/gu, ' ').slice(0, 300) : '';
  return message || undefined;
}

// preserve one GitHub response failure
async function githubResponseError(response: ResponseLike, action: string): Promise<PullRequestLookupError> {
  const payload = await response.json().catch(() => undefined);
  const status = Number.isInteger(response.status) ? ` (${response.status})` : '';
  const detail = githubErrorMessage(payload);
  return new PullRequestLookupError(detail === undefined ? `${action}${status}.` : `${action}${status}: ${detail}`, 502, response.status);
}

// identify rejected GitHub credentials
function githubAuthenticationFailure(error: unknown): boolean {
  return error instanceof PullRequestLookupError && (error.githubStatus === 401 || error.githubStatus === 403);
}

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
  private viewer?: Promise<string>;

  constructor(private readonly command: Command = run, private readonly request: Request = fetch, private readonly now: () => number = Date.now, private readonly getToken: Token = githubToken) {}

  async url(workspace: string, branch?: string): Promise<string | undefined> {
    const cached = await this.lookupCached(workspace, branch);
    return (cached?.pending === undefined ? cached?.value : await cached.pending)?.url;
  }

  // group open pull requests around the authenticated user
  async open(workspace: string): Promise<OpenPullRequestChoices> {
    const repository = await this.repository(workspace);
    // require one GitHub repository
    if (repository === undefined) throw new PullRequestLookupError('The worktree does not have a supported GitHub origin.', 503);
    this.token ??= this.getToken();
    const token = await this.token;
    // retry authentication discovery later
    if (token === undefined) {
      this.token = undefined;
      throw new PullRequestLookupError('GitHub authentication is not configured for pull request lookup.', 503);
    }
    this.viewer ??= this.viewerLogin(token);
    let viewer: string;
    try {
      viewer = await this.viewer;
    } catch (error) {
      // do not cache a failed viewer lookup
      this.viewer = undefined;
      // reload rejected credentials
      if (githubAuthenticationFailure(error)) this.token = undefined;
      throw error;
    }
    const query = new URLSearchParams({ state: 'open', per_page: '100' });
    let response: ResponseLike;
    try {
      response = await this.requiredGithubRequest(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } }, 'GitHub could not load pull requests');
    } catch (error) {
      // reload rejected credentials and viewer identity
      if (githubAuthenticationFailure(error)) {
        this.token = undefined;
        this.viewer = undefined;
      }
      throw error;
    }
    const pulls = await response.json().catch(() => undefined);
    // reject malformed success responses
    if (!Array.isArray(pulls)) throw new PullRequestLookupError('GitHub returned invalid pull request data.');
    const choices = pulls.flatMap((pull): PullRequestChoiceCandidate[] => {
      // ignore malformed pull requests
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; user?: { login?: unknown }; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } };
      // require one safe switch target
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.head?.ref !== 'string' || typeof value.head.sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(value.head.sha) || typeof value.user?.login !== 'string') return [];
      const number = value.number as number;
      const url = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pull/${number}`;
      const originRepository = `${repository.owner}/${repository.name}`;
      const headOnOrigin = typeof value.head.repo?.full_name === 'string' && value.head.repo.full_name.toLowerCase() === originRepository.toLowerCase();
      return [{ number, title: value.title, branch: value.head.ref, headSha: value.head.sha.toLowerCase(), headOnOrigin, draft: value.draft === true, url, ownedByViewer: value.user.login === viewer }];
    });
    const own = choices.filter(choice => choice.ownedByViewer);
    const others = choices.filter(choice => !choice.ownedByViewer).map(({ ownedByViewer: _ownedByViewer, ...choice }) => choice);
    return { own: await Promise.all(own.map(async ({ ownedByViewer: _ownedByViewer, ...choice }) => {
      const { headSha } = choice;
      const { checks, issues } = await this.issueStatus(repository, choice.number, headSha, token);
      return { ...choice, checks, ...(Object.keys(issues).length === 0 ? {} : { issues }) };
    })), others };
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

  // identify the authenticated GitHub user
  private async viewerLogin(token: string): Promise<string> {
    const response = await this.requiredGithubRequest('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } }, 'GitHub could not identify the authenticated user');
    const value = await response.json().catch(() => undefined);
    // require the authenticated login
    if (value === null || typeof value !== 'object' || typeof (value as { login?: unknown }).login !== 'string') throw new PullRequestLookupError('GitHub returned invalid authenticated user data.');
    return (value as { login: string }).login;
  }

  // retry transient GitHub gateway failures
  private async requiredGithubRequest(input: string, init: RequestInit, action: string): Promise<ResponseLike> {
    let lastError = new PullRequestLookupError(`${action} because the request failed.`);
    // bound upstream retries
    for (let attempt = 0; attempt < githubRequestAttempts; attempt += 1) {
      let response: ResponseLike;
      try {
        response = await this.request(input, { ...init, signal: AbortSignal.timeout(8_000) });
      } catch {
        // normalize transport failures
        lastError = new PullRequestLookupError(`${action} because the request failed.`);
        // preserve an exhausted failure
        if (attempt === githubRequestAttempts - 1) throw lastError;
        continue;
      }
      // accept one successful response
      if (response.ok) return response;
      lastError = await githubResponseError(response, action);
      // preserve permanent or exhausted failures
      if (!retryableGithubStatuses.has(response.status ?? 0) || attempt === githubRequestAttempts - 1) throw lastError;
    }
    throw lastError;
  }

  // load one branch-bound pull request
  private async lookup(repository: GithubRepository, branch: string): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100' });
    this.token ??= this.getToken();
    const token = await this.token;
    // retry token discovery later
    if (token === undefined) this.token = undefined;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const pulls = await response.json().catch(() => undefined);
    if (!Array.isArray(pulls)) return undefined;
    const summaries = pulls.flatMap((pull): PullRequestCandidate[] => {
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; state?: unknown; merged_at?: unknown; html_url?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } };
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.html_url !== 'string') return [];
      const status = typeof value.merged_at === 'string' ? 'merged' : value.state === 'open' ? value.draft === true ? 'draft' : 'open' : undefined;
      if (status === undefined) return [];
      try {
        const url = new URL(value.html_url);
        return url.protocol === 'https:' && url.hostname === 'github.com' ? [{ number: value.number as number, title: value.title, status, url: url.href, ...(typeof value.base?.ref === 'string' && value.base.ref !== '' ? { baseBranch: value.base.ref } : {}), ...(typeof value.head?.sha === 'string' && /^[a-f0-9]{40}$/iu.test(value.head.sha) ? { headSha: value.head.sha } : {}) }] : [];
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
