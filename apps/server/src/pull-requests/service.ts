import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tmux/command.js';

type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type ResponseLike = { ok: boolean; json(): Promise<unknown> };
type Request = (input: string, init?: RequestInit) => Promise<ResponseLike>;
type Token = () => Promise<string | undefined>;

type GithubRepository = { owner: string; name: string };
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

  constructor(private readonly command: Command = run, private readonly request: Request = fetch, private readonly now: () => number = Date.now, private readonly getToken: Token = githubToken) {}

  async url(workspace: string, branch?: string): Promise<string | undefined> {
    if (!branch) return undefined;
    const remote = await this.command('/usr/bin/git', ['-C', workspace, 'remote', 'get-url', 'origin']);
    const repository = remote.code === 0 ? githubRepository(remote.stdout) : undefined;
    if (!repository) return undefined;
    const key = `${repository.owner}/${repository.name}:${branch}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.pending ?? cached.value;
    const pending = this.lookup(repository, branch).catch(() => undefined).then((value) => {
      this.cache.set(key, { expiresAt: this.now() + cacheTtlMs, value });
      return value;
    });
    this.cache.set(key, { expiresAt: this.now() + cacheTtlMs, pending });
    return pending;
  }

  private async lookup(repository: GithubRepository, branch: string): Promise<string | undefined> {
    const query = new URLSearchParams({ state: 'open', head: `${repository.owner}:${branch}`, per_page: '1' });
    this.token ??= this.getToken();
    const token = await this.token;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    const [pullRequest] = await response.json() as Array<{ html_url?: unknown }>;
    if (typeof pullRequest?.html_url !== 'string') return undefined;
    const url = new URL(pullRequest.html_url);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined;
  }
}
