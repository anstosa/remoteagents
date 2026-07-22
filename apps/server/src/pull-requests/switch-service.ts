import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { LaunchService } from '../launch/service.js';
import { run } from '../tmux/command.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hostTmux = '/usr/local/bin/host-tmux';

export class PullRequestSwitchService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly hostWorkspace: string | undefined;

  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly launch: LaunchService, private readonly pullRequests = new PullRequestService()) {
    this.hostWorkspace = process.env.RAC_HOST_WORKSPACE ?? config.worktrees.find(worktree => worktree.id === 'remoteagents')?.hostPath;
  }

  async available(agentId: string): Promise<PullRequestChoice[] | undefined> {
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
    if (worktree === undefined || !await this.cleanAndPushed(worktree)) return undefined;
    return this.pullRequests.ownOpen(worktree.identity);
  }

  async switch(agentId: string, number: number): Promise<boolean> {
    if (!Number.isInteger(number) || number < 1) return false;
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.workspace);
    if (target === undefined || worktree === undefined || !await this.cleanAndPushed(worktree)) return false;
    const pullRequest = (await this.pullRequests.ownOpen(worktree.identity))?.find(candidate => candidate.number === number);
    if (pullRequest === undefined || !await this.tmux.close(target.socket, target.agent.paneId)) return false;
    if (!await this.switchBranch(worktree, pullRequest.branch)) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
    return this.launch.launch(worktree.id);
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.config.worktrees.find(worktree => workspace === worktree.identity || workspace === worktree.hostPath);
  }

  private async cleanAndPushed(worktree: Worktree): Promise<boolean> {
    const status = await run('/usr/bin/git', ['-C', worktree.identity, 'status', '--porcelain=v1']);
    if (status.code !== 0 || status.stdout.trim()) return false;
    const upstream = await run('/usr/bin/git', ['-C', worktree.identity, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.code !== 0 || !upstream.stdout.trim()) return false;
    const divergence = await run('/usr/bin/git', ['-C', worktree.identity, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    return divergence.code === 0 && /^0\s+0\s*$/u.test(divergence.stdout);
  }

  private async switchBranch(worktree: Worktree, branch: string): Promise<boolean> {
    if (this.socket === undefined || this.hostWorkspace === undefined) return false;
    const name = `switch-pr-${randomBytes(8).toString('hex')}`;
    const containerFile = join('/workspace', '.data', 'pr-switch', name);
    const hostFile = join(this.hostWorkspace, '.data', 'pr-switch', name);
    await mkdir(dirname(containerFile), { recursive: true, mode: 0o700 });
    const directory = worktree.hostPath ?? worktree.identity;
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `origin/${branch}`;
    const switchCommand = `git fetch origin -- ${quote(branch)} && if git show-ref --verify --quiet ${quote(localRef)}; then git switch -- ${quote(branch)}; else git switch -c ${quote(branch)} --track ${quote(remoteRef)}; fi`;
    const script = `export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; cd -- ${quote(directory)}; { ${switchCommand}; }; printf '%s' "$?" > ${quote(hostFile)}`;
    const session = `rac-pr-switch-${randomBytes(9).toString('hex')}`;
    if ((await run(hostTmux, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', directory, '/bin/bash', '-lc', script])).code !== 0) return false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = await readFile(containerFile, 'utf8').catch(() => undefined);
        if (result !== undefined) return result.trim() === '0';
      }
      return false;
    } finally { await unlink(containerFile).catch(() => {}); }
  }
}
