import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentKind } from '../adapters/types.js';
import { agentKinds } from '../adapters/types.js';
import type { ValidatedConfig } from '../config/schema.js';
import { run } from '../tmux/command.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';

const statusTimeoutMs = 15_000;
const updateTimeoutMs = 5 * 60_000;
const cacheTtlMs = 15 * 60_000;
const failedCacheTtlMs = 60_000;
const maxOutputBytes = 16 * 1024;
// quote one trusted command wrapper value for the host shell
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export type AgentUpdateStatus = { kind: AgentKind; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string };
export type AgentUpdateResult = { outcome: 'updated'; status: AgentUpdateStatus } | { outcome: 'unavailable' } | { outcome: 'busy' } | { outcome: 'failed' };
export type AgentUpdateRunner = (command: string, timeoutMs: number) => Promise<{ code: number; output: string }>;
export type AgentUpdateServiceLike = Pick<AgentUpdateService, 'statuses' | 'update'>;

// remove terminal controls and retain one bounded version line
export function normalizedVersion(output: string): string | undefined {
  const plain = output
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const line = plain.split(/\r?\n/gu).map(value => value.trim()).find(Boolean);
  return line === undefined ? undefined : line.slice(0, 120);
}

// read only the newest bounded command output
async function readOutput(path: string): Promise<string> {
  const file = await open(path, 'r').catch(() => undefined);
  // tolerate a command that produced no output
  if (file === undefined) return '';
  try {
    const details = await file.stat();
    const length = Math.min(details.size, maxOutputBytes);
    // avoid an unnecessary read for an empty file
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const result = await file.read(buffer, 0, length, details.size - length);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export class AgentUpdateService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly checkout: string;
  private readonly hostCheckout: string | undefined;
  private readonly runner: AgentUpdateRunner;
  private readonly cache = new Map<AgentKind, { status: AgentUpdateStatus; expiresAt: number }>();
  private readonly refreshes = new Map<AgentKind, Promise<AgentUpdateStatus>>();
  private updating: AgentKind | undefined;

  // bind update commands to the launch account and host bridge
  constructor(private readonly config: ValidatedConfig, private readonly home: string, runner?: AgentUpdateRunner, checkout: string = serverCheckout()) {
    this.checkout = checkout;
    this.hostCheckout = serverCheckoutOnHost(config.projects, process.env.RAC_HOST_WORKSPACE, checkout);
    this.runner = runner ?? ((command, timeoutMs) => this.runConfigured(command, timeoutMs));
  }

  // publish every configured update-capable agent in registry order
  async statuses(): Promise<AgentUpdateStatus[]> {
    const kinds = agentKinds.filter(kind => this.config.adapters?.[kind]?.updates !== undefined);
    return await Promise.all(kinds.map(kind => this.status(kind)));
  }

  // execute one configured update and refresh its versions
  async update(kind: AgentKind): Promise<AgentUpdateResult> {
    const commands = this.config.adapters?.[kind]?.updates;
    // refuse kinds without a complete update contract
    if (commands === undefined) return { outcome: 'unavailable' };
    // serialize updates for one installation
    if (this.updating !== undefined) return { outcome: 'busy' };
    this.updating = kind;
    try {
      const activeRefresh = this.refreshes.get(kind);
      // finish an older version read before mutating the installation
      if (activeRefresh !== undefined) await activeRefresh.catch(() => undefined);
      const result = await this.runner(commands.run, updateTimeoutMs).catch(() => ({ code: -1, output: '' }));
      // do not claim an update when the command failed
      if (result.code !== 0) return { outcome: 'failed' };
      this.cache.delete(kind);
      return { outcome: 'updated', status: await this.status(kind, true) };
    } finally {
      this.updating = undefined;
    }
  }

  // resolve one cached version comparison
  private async status(kind: AgentKind, force = false): Promise<AgentUpdateStatus> {
    const cached = this.cache.get(kind);
    // serve a fresh cached comparison
    if (!force && cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
    const active = this.refreshes.get(kind);
    // coalesce concurrent checks
    if (active !== undefined) return await active;
    const refresh = this.refresh(kind).finally(() => { this.refreshes.delete(kind); });
    this.refreshes.set(kind, refresh);
    return await refresh;
  }

  // run and compare the configured current and upstream version commands
  private async refresh(kind: AgentKind): Promise<AgentUpdateStatus> {
    const commands = this.config.adapters?.[kind]?.updates;
    // retain a safe fallback for a configuration change during runtime
    if (commands === undefined) return { kind, updateAvailable: false, error: 'Version check unavailable' };
    const [current, latest] = await Promise.all([
      this.runner(commands.current, statusTimeoutMs).catch(() => ({ code: -1, output: '' })),
      this.runner(commands.latest, statusTimeoutMs).catch(() => ({ code: -1, output: '' }))
    ]);
    const currentVersion = current.code === 0 ? normalizedVersion(current.output) : undefined;
    const latestVersion = latest.code === 0 ? normalizedVersion(latest.output) : undefined;
    const failed = currentVersion === undefined || latestVersion === undefined;
    const status: AgentUpdateStatus = failed
      ? { kind, ...(currentVersion === undefined ? {} : { currentVersion }), ...(latestVersion === undefined ? {} : { latestVersion }), updateAvailable: false, error: 'Version check failed' }
      : { kind, currentVersion, latestVersion, updateAvailable: currentVersion !== latestVersion };
    this.cache.set(kind, { status, expiresAt: Date.now() + (failed ? failedCacheTtlMs : cacheTtlMs) });
    return status;
  }

  // execute a trusted command locally or through the host tmux bridge
  private async runConfigured(command: string, timeoutMs: number): Promise<{ code: number; output: string }> {
    const path = process.env.RAC_HOST_PATH?.trim();
    const prefix = `export HOME=${quote(this.home)}; ${path ? `export PATH=${quote(path)}; ` : ''}cd -- ${quote(this.home)}; `;
    // use the local shell for direct deployments
    if (this.socket === undefined) {
      const result = await run('/bin/bash', ['-lc', `${prefix}{ ${command}; }`], undefined, timeoutMs);
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    }
    // a bridged command needs a shared checkout for completion files
    if (this.hostCheckout === undefined) return { code: -1, output: '' };
    const token = randomBytes(12).toString('hex');
    const session = `rac-agent-update-${token}`;
    const localBase = join(this.checkout, '.data', 'agent-updates', token);
    const hostBase = join(this.hostCheckout, '.data', 'agent-updates', token);
    const outputFile = `${localBase}.out`;
    const statusFile = `${localBase}.status`;
    const temporaryStatusFile = `${localBase}.status.tmp`;
    await mkdir(dirname(localBase), { recursive: true, mode: 0o700 });
    const script = `${prefix}{ ${command}; } > ${quote(`${hostBase}.out`)} 2>&1; code=$?; printf '%s' "$code" > ${quote(`${hostBase}.status.tmp`)}; mv -- ${quote(`${hostBase}.status.tmp`)} ${quote(`${hostBase}.status`)}`;
    try {
      const launched = await run(this.tmuxBinary, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', this.home, '/bin/bash', '-lc', script]);
      // fail when the host tmux rejects the command
      if (launched.code !== 0) return { code: launched.code, output: launched.stderr };
      const deadline = Date.now() + timeoutMs;
      // wait for the atomic completion marker
      while (Date.now() < deadline) {
        const status = await readFile(statusFile, 'utf8').catch(() => undefined);
        // return only after output has closed
        if (status !== undefined) return { code: Number.parseInt(status.trim(), 10), output: await readOutput(outputFile) };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { code: -1, output: await readOutput(outputFile) };
    } finally {
      // stop writers before removing shared completion files
      await run(this.tmuxBinary, ['-S', this.socket, 'kill-session', '-t', `=${session}`]).catch(() => undefined);
      await Promise.all([
        unlink(outputFile).catch(() => {}),
        unlink(statusFile).catch(() => {}),
        unlink(temporaryStatusFile).catch(() => {})
      ]);
    }
  }
}
