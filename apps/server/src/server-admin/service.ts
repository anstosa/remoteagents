import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';

export type ServerUpdateState = 'queued' | 'running' | 'complete' | 'failed';
export type ServerUpdateStatus = { id: string; kind: 'update'; state: ServerUpdateState };
type RunCommand = typeof run;

export type ServerAdminOptions = {
  configWritePath?: string;
  hostRepository?: string;
  statusDirectory?: string;
  tmuxBinary?: string;
  tmuxSocket?: string;
  runCommand?: RunCommand;
};

const operationPattern = /^[A-Za-z0-9_-]{20,64}$/u;

// persist identity and launch host updates
export class ServerAdminService {
  private readonly configWritePath: string;
  private readonly hostRepository: string | undefined;
  private readonly statusDirectory: string;
  private readonly tmuxBinary: string;
  private readonly tmuxSocket: string | undefined;
  private readonly runCommand: RunCommand;

  // resolve deployment paths once
  constructor(config: ValidatedConfig, options: ServerAdminOptions = {}) {
    this.configWritePath = options.configWritePath ?? process.env.RAC_CONFIG_WRITE_PATH ?? process.env.RAC_CONFIG ?? '';
    this.hostRepository = options.hostRepository ?? process.env.RAC_HOST_REPOSITORY ?? config.worktrees.find(worktree => worktree.path === '/workspace' || worktree.identity === '/workspace')?.hostPath;
    this.statusDirectory = options.statusDirectory ?? process.env.RAC_SERVER_ADMIN_STATUS_DIR ?? '/workspace/.data';
    this.tmuxBinary = options.tmuxBinary ?? process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
    this.tmuxSocket = options.tmuxSocket ?? (process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default'));
    this.runCommand = options.runCommand ?? run;
  }

  // replace only the persisted server name
  async renameServer(name: string): Promise<string | undefined> {
    const normalized = name.trim();
    // match configuration validation
    if (!normalized || normalized.length > 80 || normalized.includes('\0') || !this.configWritePath) return undefined;
    const raw = JSON.parse(await readFile(this.configWritePath, 'utf8')) as unknown;
    // require one object configuration
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const updated = { ...raw, name: normalized };
    const temporary = `${this.configWritePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(dirname(this.configWritePath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.configWritePath);
    return normalized;
  }

  // launch the fixed host update script
  async startUpdate(): Promise<ServerUpdateStatus | undefined> {
    // require an explicit host repository mapping
    if (this.hostRepository === undefined || this.tmuxSocket === undefined) return undefined;
    const id = randomBytes(24).toString('base64url');
    const status: ServerUpdateStatus = { id, kind: 'update', state: 'queued' };
    await mkdir(this.statusDirectory, { recursive: true });
    await writeFile(this.statusPath(id), `${JSON.stringify(status)}\n`, { mode: 0o600 });
    const session = `rac-update-${id.slice(0, 12)}`;
    const script = join(this.hostRepository, 'scripts', 'update-server.sh');
    const result = await this.runCommand(this.tmuxBinary, ['-S', this.tmuxSocket, 'new-session', '-d', '-s', session, '-c', this.hostRepository, '/bin/bash', script, id], undefined, 5_000);
    // replace queued state after launch failure
    if (result.code !== 0) {
      const failed: ServerUpdateStatus = { ...status, state: 'failed' };
      await writeFile(this.statusPath(id), `${JSON.stringify(failed)}\n`, { mode: 0o600 });
      return failed;
    }
    return status;
  }

  // read one bounded update state
  async updateStatus(id: string): Promise<ServerUpdateStatus | undefined> {
    // reject traversal and unknown identifiers
    if (!operationPattern.test(id)) return undefined;
    try {
      const raw = await readFile(this.statusPath(id), 'utf8');
      // bound and validate script output
      if (raw.length > 4_096) return undefined;
      const value = JSON.parse(raw) as Partial<ServerUpdateStatus>;
      if (value.id !== id || value.kind !== 'update' || !['queued', 'running', 'complete', 'failed'].includes(value.state ?? '')) return undefined;
      return value as ServerUpdateStatus;
    } catch {
      return undefined;
    }
  }

  // contain operation files
  private statusPath(id: string): string {
    return join(this.statusDirectory, `server-update-${id}.json`);
  }
}
