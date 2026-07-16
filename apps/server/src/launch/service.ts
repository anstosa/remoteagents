import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { expandLaunch } from '../config/schema.js';
import { run } from '../tmux/command.js';
export class LaunchService {
  private pending = new Set<string>(); private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`;
  constructor(private readonly config: ValidatedConfig) {}
  async launch(worktreeId: string): Promise<boolean> { const worktree = this.config.worktrees.find(w => w.id === worktreeId); if (!worktree || this.pending.has(worktreeId)) return false; this.pending.add(worktreeId); try { await mkdir(this.root, { recursive: true, mode: 0o700 }); const id = randomBytes(18).toString('base64url'); const descriptor = join(this.root, `${id}.json`); const payload = JSON.stringify({ program: worktree.launch.program, args: expandLaunch(worktree.launch, worktree), cwd: worktree.identity }); const handle = await open(descriptor, 'wx', 0o600); await handle.writeFile(payload); await handle.close(); const session = `rac-${id.slice(0, 12)}`; const runner = new URL('./runner.js', import.meta.url).pathname; const created = await run('/usr/bin/tmux', ['new-session', '-d', '-s', session, process.execPath, runner, descriptor]); if (created.code !== 0) { await unlink(descriptor).catch(() => {}); return false; } return true; } finally { this.pending.delete(worktreeId); } }
}
