import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tmux/command.js';

type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type ResponseLike = { ok: boolean; json(): Promise<unknown> };
type Request = (input: string, init?: RequestInit) => Promise<ResponseLike>;
type Token = () => Promise<string | undefined>;

type GithubRepository = { owner: string; name: string };
export type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string };
const cacheTtlMs = 60_000;

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
  private readonly cache = new Map<string, { expiresAt: number; value?: string; pending?: Promise<string | undefined> }>();
  private token?: Promise<string | undefined>;
  private viewer?: Promise<string | undefined>;

  constructor(private readonly command: Command = run, private readonly request: Request = fetch, private readonly now: () => number = Date.now, private readonly getToken: Token = githubToken) {}

  async url(workspace: string, branch?: string): Promise<string | undefined> {
    const cached = await this.lookupCached(workspace, branch);
    return cached?.pending ?? cached?.value;
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
    return pulls.flatMap((pull): PullRequestChoice[] => {
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; html_url?: unknown; user?: { login?: unknown }; head?: { ref?: unknown } };
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.head?.ref !== 'string' || typeof value.user?.login !== 'string' || value.user.login !== viewer || typeof value.html_url !== 'string') return [];
      try {
        const url = new URL(value.html_url);
        return url.protocol === 'https:' && url.hostname === 'github.com' ? [{ number: value.number as number, title: value.title, branch: value.head.ref, draft: value.draft === true, url: url.href }] : [];
      } catch { return []; }
    });
  }

  /**
   * Dashboard rendering must not wait on GitHub. It can use a previous URL,
   * start a refresh when needed, and pick up the result on its next poll.
   */
  async cachedUrl(workspace: string, branch?: string): Promise<string | undefined> {
    return (await this.lookupCached(workspace, branch))?.value;
  }

  private async lookupCached(workspace: string, branch?: string): Promise<{ expiresAt: number; value?: string; pending?: Promise<string | undefined> } | undefined> {
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

  private async lookup(repository: GithubRepository, branch: string): Promise<string | undefined> {
    const query = new URLSearchParams({ state: 'open', head: `${repository.owner}:${branch}`, per_page: '1' });
    this.token ??= this.getToken();
    const token = await this.token;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const [pullRequest] = await response.json() as Array<{ html_url?: unknown }>;
    if (typeof pullRequest?.html_url !== 'string') return undefined;
    const url = new URL(pullRequest.html_url);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined;
  }
}
