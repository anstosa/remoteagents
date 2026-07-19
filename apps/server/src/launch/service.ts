import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { expandLaunch } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import type { Pane, SocketRef, Worktree } from '../domain/models.js';

export function expandCommand(command: string, worktree: Pick<Worktree, 'identity'>): string {
  const directory = `'${worktree.identity.replaceAll("'", "'\\''")}'`;
  const script = `'${command.replaceAll("'", "'\\''")}'`;
  return `if [ -f "$HOME/.bash_aliases" ]; then shopt -s expand_aliases; source "$HOME/.bash_aliases"; fi\ncd -- ${directory} && eval ${script}`;
}

export class LaunchService {
  private pending = new Set<string>(); private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`; private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter()) {}
  private async existingPane(worktree: Worktree): Promise<{ socket: SocketRef; pane: Pane } | undefined> { const roots = [worktree.hostPath, worktree.identity].filter((path): path is string => path !== undefined); for (const socket of await this.finder.find()) for (const pane of await this.panes.listPanes(socket)) if (roots.some(root => pane.path === root || pane.path.startsWith(`${root}/`))) return { socket, pane }; return undefined; }
  async launch(worktreeId: string): Promise<boolean> { const worktree = this.config.worktrees.find(w => w.id === worktreeId); if (!worktree || this.pending.has(worktreeId)) return false; this.pending.add(worktreeId); try { const id = randomBytes(18).toString('base64url'); if (worktree.command !== undefined) { const existing = await this.existingPane(worktree); if (existing !== undefined) { const buffer = `rac-launch-${id}`; return await this.panes.pastePrompt(existing.socket, existing.pane.paneId, buffer, worktree.command) && await this.panes.enter(existing.socket, existing.pane.paneId); } } const session = `rac-${id.slice(0, 12)}`; if (this.hostSocket !== undefined && worktree.command !== undefined) { const hostWorktree = { ...worktree, identity: worktree.hostPath ?? worktree.identity }; return (await run(this.tmux, ['-S', this.hostSocket, 'new-session', '-d', '-s', session, '/bin/bash', '-lc', expandCommand(worktree.command, hostWorktree)])).code === 0; } await mkdir(this.root, { recursive: true, mode: 0o700 }); const descriptor = join(this.root, `${id}.json`); const payload = worktree.command === undefined ? { program: worktree.launch!.program, args: expandLaunch(worktree.launch!, worktree), cwd: worktree.identity } : { program: '/bin/bash', args: ['-c', expandCommand(worktree.command, worktree)], cwd: worktree.identity }; const handle = await open(descriptor, 'wx', 0o600); await handle.writeFile(JSON.stringify(payload)); await handle.close(); const runner = new URL('./runner.js', import.meta.url).pathname; const created = await run(this.tmux, ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]); if (created.code !== 0) { await unlink(descriptor).catch(() => {}); return false; } return true; } finally { this.pending.delete(worktreeId); } }
}
