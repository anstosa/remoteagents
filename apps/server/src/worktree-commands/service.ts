import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { stackActions, type StackAction, type Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const commandPath = '/usr/local/bin/host-tmux';

export class WorktreeCommandService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly hostWorkspace: string | undefined;
  private readonly statusCache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(private readonly config: ValidatedConfig) {
    this.hostWorkspace = process.env.RAC_HOST_WORKSPACE ?? config.worktrees.find(worktree => worktree.id === 'remoteagents')?.hostPath;
  }

  actions(worktree: Worktree): StackAction[] { return stackActions.filter(action => worktree.commands?.[action] !== undefined); }

  async run(worktreeId: string, action: StackAction): Promise<boolean> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    const command = worktree?.commands?.[action];
    if (worktree === undefined || command === undefined) return false;
    return this.detached(worktree, command);
  }

  async running(worktree: Worktree): Promise<boolean | undefined> {
    const command = worktree.commands?.status;
    if (command === undefined || this.socket === undefined || this.hostWorkspace === undefined) return undefined;
    const cached = this.statusCache.get(worktree.id);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const name = `stack-${worktree.id}-${randomBytes(6).toString('hex')}`;
    const containerFile = join('/workspace', '.data', 'stack-status', name);
    const hostFile = join(this.hostWorkspace, '.data', 'stack-status', name);
    await mkdir(dirname(containerFile), { recursive: true, mode: 0o700 });
    const script = `export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; cd -- ${quote(worktree.hostPath ?? worktree.identity)}; { ${command}; }; printf '%s' "$?" > ${quote(hostFile)}`;
    if (!await this.detached(worktree, script)) return undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = await readFile(containerFile, 'utf8').catch(() => undefined);
      if (result === undefined) continue;
      await unlink(containerFile).catch(() => {});
      const value = result.trim() === '0';
      this.statusCache.set(worktree.id, { value, expiresAt: Date.now() + 3_000 });
      return value;
    }
    return undefined;
  }

  private async detached(worktree: Worktree, command: string): Promise<boolean> {
    if (this.socket === undefined) return false;
    const session = `rac-stack-${randomBytes(9).toString('hex')}`;
    const directory = worktree.hostPath ?? worktree.identity;
    const script = `export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; cd -- ${quote(directory)} && ${command}`;
    return (await run(commandPath, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', directory, '/bin/bash', '-lc', script])).code === 0;
  }
}
