import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';

export type ServerUpdateState = 'queued' | 'running' | 'complete' | 'failed';
export type ServerUpdateStatus = { id: string; kind: 'update'; state: ServerUpdateState };
type RunCommand = typeof run;
type ServerUpdateAvailabilityState = 'available' | 'current' | 'failed';
type ServerUpdateAvailability = { kind: 'update-availability'; state: ServerUpdateAvailabilityState };

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
  private availabilityCheck?: Promise<boolean | undefined>;
  private updateLaunch?: Promise<ServerUpdateStatus | undefined>;
  private activeUpdate?: ServerUpdateStatus;

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
    // share concurrent launch requests
    if (this.updateLaunch !== undefined) return await this.updateLaunch;
    const launch = this.launchUpdate().finally(() => {
      // release only the matching launch
      if (this.updateLaunch === launch) this.updateLaunch = undefined;
    });
    this.updateLaunch = launch;
    return await launch;
  }

  // launch or reuse one active host update
  private async launchUpdate(): Promise<ServerUpdateStatus | undefined> {
    // require an explicit host repository mapping
    if (this.hostRepository === undefined || this.tmuxSocket === undefined) return undefined;
    // reuse an update that has not reached a terminal state
    if (this.activeUpdate !== undefined) {
      const current = await this.updateStatus(this.activeUpdate.id);
      // preserve one host mutation at a time
      if (current?.state === 'queued' || current?.state === 'running') {
        this.activeUpdate = current;
        return current;
      }
      this.activeUpdate = undefined;
    }
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
    this.activeUpdate = status;
    return status;
  }

  // check origin main through the host bridge
  async updateAvailable(): Promise<boolean | undefined> {
    // require the same host authority as updates
    if (this.hostRepository === undefined || this.tmuxSocket === undefined) return undefined;
    // share one fetch across concurrent clients
    if (this.availabilityCheck !== undefined) return await this.availabilityCheck;
    const check = this.checkUpdateAvailable(this.hostRepository, this.tmuxSocket);
    this.availabilityCheck = check;
    try {
      return await check;
    } finally {
      this.availabilityCheck = undefined;
    }
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

  // run one fixed upstream check on the host
  private async checkUpdateAvailable(hostRepository: string, tmuxSocket: string): Promise<boolean | undefined> {
    const statusPath = join(this.statusDirectory, 'server-update-availability.json');
    await mkdir(this.statusDirectory, { recursive: true });
    await rm(statusPath, { force: true });
    const script = join(hostRepository, 'scripts', 'check-server-update.sh');
    const command = `/bin/bash '${script.replaceAll("'", "'\\''")}'`;
    const result = await this.runCommand(this.tmuxBinary, ['-S', tmuxSocket, 'run-shell', command], undefined, 30_000);
    // reject bridge or script failures
    if (result.code !== 0) return undefined;
    try {
      const raw = await readFile(statusPath, 'utf8');
      // bound host-produced state
      if (raw.length > 1_024) return undefined;
      const value = JSON.parse(raw) as Partial<ServerUpdateAvailability>;
      // require the fixed availability contract
      if (value.kind !== 'update-availability' || !['available', 'current', 'failed'].includes(value.state ?? '')) return undefined;
      return value.state === 'available' ? true : value.state === 'current' ? false : undefined;
    } catch {
      return undefined;
    }
  }
}
