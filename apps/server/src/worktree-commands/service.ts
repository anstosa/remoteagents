import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { stackActions, type StackAction, type Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const commandPath = '/usr/local/bin/host-tmux';
type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export class WorktreeCommandService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly hostWorkspace: string | undefined;
  private readonly statusCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly statusRefreshes = new Map<string, Promise<void>>();
  private readonly transitions = new Map<string, { value: 'starting'|'migrating'; expiresAt: number }>();
  private readonly operations = new Map<string, { action: StackAction; session: string }>();
  private readonly tunnelCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly tunnelRefreshes = new Map<string, Promise<void>>();

  constructor(private readonly config: ValidatedConfig, private readonly command: Command = run) {
    this.hostWorkspace = process.env.RAC_HOST_WORKSPACE ?? config.worktrees.find(worktree => worktree.id === 'remoteagents')?.hostPath;
  }

  actions(worktree: Worktree): StackAction[] { return stackActions.filter(action => worktree.commands?.[action] !== undefined); }

  async run(worktreeId: string, action: StackAction): Promise<boolean> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    const command = worktree?.commands?.[action];
    if (worktree === undefined || command === undefined) return false;
    const session = await this.detachedSession(worktree, command, action);
    if (session !== undefined) {
      this.operations.set(worktree.id, { action, session });
      this.statusCache.delete(worktree.id);
      if (action === 'start' || action === 'migrate') this.transitions.set(worktree.id, { value: action === 'start' ? 'starting' : 'migrating', expiresAt: Date.now() + (action === 'start' ? 60_000 : 10 * 60_000) });
    }
    return session !== undefined;
  }

  async state(worktree: Worktree): Promise<{ running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean }> {
    const [running, tunnel, operation] = await Promise.all([this.running(worktree), this.tunnel(worktree), this.operation(worktree)]);
    const transition = this.transitions.get(worktree.id);
    if (transition !== undefined && transition.expiresAt <= Date.now()) this.transitions.delete(worktree.id);
    const activeTransition = this.transitions.get(worktree.id)?.value;
    return { ...(running === undefined ? {} : { running }), ...(activeTransition === undefined ? {} : { transition: activeTransition }), ...(operation === undefined ? {} : { operation }), ...(tunnel === undefined ? {} : { tunnel }) };
  }

  async running(worktree: Worktree): Promise<boolean | undefined> {
    const command = worktree.commands?.status;
    if (command === undefined || this.socket === undefined || this.hostWorkspace === undefined) return undefined;
    const cached = this.statusCache.get(worktree.id);
    if (cached === undefined || cached.expiresAt <= Date.now()) void this.refreshStatus(worktree, command);
    return cached?.value;
  }

  private refreshStatus(worktree: Worktree, command: string): Promise<void> {
    const active = this.statusRefreshes.get(worktree.id);
    if (active !== undefined) return active;
    const refresh = (async () => {
      const name = `stack-${worktree.id}-${randomBytes(6).toString('hex')}`;
      const containerFile = join('/workspace', '.data', 'stack-status', name);
      try {
        const hostFile = join(this.hostWorkspace!, '.data', 'stack-status', name);
        await mkdir(dirname(containerFile), { recursive: true, mode: 0o700 });
        const script = `export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; cd -- ${quote(worktree.hostPath ?? worktree.identity)}; { ${command}; }; printf '%s' "$?" > ${quote(hostFile)}`;
        if (!await this.detached(worktree, script)) return;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const result = await readFile(containerFile, 'utf8').catch(() => undefined);
          if (result === undefined) continue;
          this.statusCache.set(worktree.id, { value: result.trim() === '0', expiresAt: Date.now() + 10_000 });
          return;
        }
      } catch { /* Stack probing must never delay console traffic. */ }
      finally { await unlink(containerFile).catch(() => {}); }
    })().finally(() => { this.statusRefreshes.delete(worktree.id); });
    this.statusRefreshes.set(worktree.id, refresh);
    return refresh;
  }

  private async tunnel(worktree: Worktree): Promise<boolean | undefined> {
    if (worktree.projectUrl === undefined) return undefined;
    const cached = this.tunnelCache.get(worktree.id);
    if (cached === undefined || cached.expiresAt <= Date.now()) void this.refreshTunnel(worktree);
    return cached?.value;
  }

  private refreshTunnel(worktree: Worktree): Promise<void> {
    const active = this.tunnelRefreshes.get(worktree.id);
    if (active !== undefined) return active;
    const refresh = fetch(worktree.projectUrl!, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
      .then(response => response.status >= 200 && response.status < 500)
      .catch(() => false)
      .then(value => { this.tunnelCache.set(worktree.id, { value, expiresAt: Date.now() + 10_000 }); })
      .finally(() => { this.tunnelRefreshes.delete(worktree.id); });
    this.tunnelRefreshes.set(worktree.id, refresh);
    return refresh;
  }

  private async operation(worktree: Worktree): Promise<StackAction | undefined> {
    const operation = this.operations.get(worktree.id);
    if (operation === undefined || this.socket === undefined) return undefined;
    const active = (await this.command(commandPath, ['-S', this.socket, 'has-session', '-t', `=${operation.session}`])).code === 0;
    if (!active) {
      this.operations.delete(worktree.id);
      return undefined;
    }
    return operation.action;
  }

  private async detached(worktree: Worktree, command: string): Promise<boolean> {
    return await this.detachedSession(worktree, command) !== undefined;
  }

  private async detachedSession(worktree: Worktree, command: string, action?: StackAction): Promise<string | undefined> {
    if (this.socket === undefined) return undefined;
    const session = `rac-stack-${worktree.id}${action === undefined ? '' : `-${action}`}-${randomBytes(9).toString('hex')}`;
    const directory = worktree.hostPath ?? worktree.identity;
    const script = `export PATH="$HOME/n/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; cd -- ${quote(directory)} && ${command}`;
    return (await this.command(commandPath, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', directory, '/bin/bash', '-lc', script])).code === 0 ? session : undefined;
  }
}
