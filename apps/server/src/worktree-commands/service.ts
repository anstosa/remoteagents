import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import { stackActions, type StackAction, type Worktree } from '../domain/models.js';
import { worktreeHostRoot } from '../workspaces/resolver.js';
import { run } from '../tmux/command.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;
type StackOperation = { action: StackAction; session: string; startedAt: string; completedAt?: string; logFile?: string };
export type StackOperationLog = { action: StackAction; active: boolean; startedAt: string; completedAt?: string; output: string };
const maxStackLogBytes = 128 * 1024;

// prepend an explicitly configured host executable path
const hostPathExport = () => {
  const path = process.env.RAC_HOST_PATH?.trim();
  return path ? `export PATH=${quote(path)}; ` : '';
};

// remove terminal controls from persisted command output
const plainLog = (value: string) => value
  .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\r/gu, '');

// read only the newest bounded log output
const readLogTail = async (path: string): Promise<string> => {
  const file = await open(path, 'r').catch(() => undefined);
  // tolerate commands that have not written output yet
  if (file === undefined) return '';
  try {
    const details = await file.stat();
    const length = Math.min(details.size, maxStackLogBytes);
    // return an empty file directly
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const result = await file.read(buffer, 0, length, details.size - length);
    return plainLog(buffer.subarray(0, result.bytesRead).toString('utf8'));
  } finally { await file.close(); }
};

export class WorktreeCommandService {
  private readonly socket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly hostWorkspace: string | undefined;
  private readonly statusCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly statusRefreshes = new Map<string, Promise<void>>();
  private readonly transitions = new Map<string, { value: 'starting'|'migrating'; expiresAt: number }>();
  private readonly operations = new Map<string, StackOperation>();
  private readonly launchingOperations = new Set<string>();
  private readonly tunnelCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly tunnelRefreshes = new Map<string, Promise<void>>();

  constructor(private readonly config: ValidatedConfig, private readonly command: Command = run) {
    this.hostWorkspace = process.env.RAC_HOST_WORKSPACE ?? config.worktrees.find(worktree => worktree.id === 'remoteagents')?.hostPath;
  }

  actions(worktree: Worktree): StackAction[] { return stackActions.filter(action => worktree.commands?.[action] !== undefined); }

  async run(worktreeId: string, action: StackAction): Promise<boolean> {
    return await this.start(worktreeId, action) === 'started';
  }

  // start one exclusive stack operation
  async start(worktreeId: string, action: StackAction): Promise<'started'|'busy'|false> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    const command = worktree?.commands?.[action];
    // require a configured action
    if (worktree === undefined || command === undefined) return false;
    // serialize launch checks per worktree
    if (this.launchingOperations.has(worktree.id)) return 'busy';
    this.launchingOperations.add(worktree.id);
    const previous = this.operations.get(worktree.id);
    try {
      const sessionName = this.operationSession(worktree);
      // reject overlapping detached sessions
      if (previous !== undefined && await this.operationActive(previous)) return 'busy';
      const session = await this.detachedSession(worktree, command, action);
      // retain the newest operation and its log
      if (session !== undefined) {
        this.operations.set(worktree.id, session);
        // discard only completed output files
        if (previous?.logFile !== undefined) await unlink(previous.logFile).catch(() => {});
        this.statusCache.delete(worktree.id);
        if (action === 'start' || action === 'migrate') this.transitions.set(worktree.id, { value: action === 'start' ? 'starting' : 'migrating', expiresAt: Date.now() + (action === 'start' ? 60_000 : 10 * 60_000) });
      }
      // recognize existing sessions and preserve safety after probe failures
      if (session === undefined && await this.sessionStatus(sessionName) !== 'absent') return 'busy';
      return session === undefined ? false : 'started';
    } finally {
      this.launchingOperations.delete(worktree.id);
    }
  }

  // return the latest operation output
  async log(worktreeId: string): Promise<StackOperationLog | undefined> {
    const worktree = this.config.worktrees.find(candidate => candidate.id === worktreeId);
    const operation = worktree === undefined ? undefined : this.operations.get(worktree.id);
    // hide unknown worktrees and untouched stacks
    if (worktree === undefined || operation === undefined) return undefined;
    const active = await this.operationActive(operation);
    const output = operation.logFile === undefined ? '' : await readLogTail(operation.logFile);
    return { action: operation.action, active, startedAt: operation.startedAt, ...(operation.completedAt === undefined ? {} : { completedAt: operation.completedAt }), output };
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
        const script = `${hostPathExport()}cd -- ${quote(worktreeHostRoot(worktree))}; { ${command}; }; printf '%s' "$?" > ${quote(hostFile)}`;
        if (!await this.detached(worktree, script)) return;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const result = await readFile(containerFile, 'utf8').catch(() => undefined);
          if (result === undefined) continue;
          this.statusCache.set(worktree.id, { value: result.trim() === '0', expiresAt: Date.now() + 30_000 });
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
    // report only active operations to the dashboard
    return operation !== undefined && await this.operationActive(operation) ? operation.action : undefined;
  }

  // detect completion while retaining the finished log
  private async operationActive(operation: StackOperation): Promise<boolean> {
    // reuse a settled completion
    if (operation.completedAt !== undefined || this.socket === undefined) return false;
    const status = await this.sessionStatus(operation.session);
    // retain active state when tmux cannot answer reliably
    if (status === 'unknown') return true;
    const active = status === 'active';
    // preserve the first observed completion time
    if (!active) operation.completedAt = new Date().toISOString();
    return active;
  }

  // derive one atomic cross-process operation session
  private operationSession(worktree: Worktree): string {
    const actionLabel = this.actions(worktree)[0] ?? 'operation';
    return `rac-stack-${worktree.id}-${actionLabel}-exclusive`;
  }

  // distinguish a missing session from a broken tmux probe
  private async sessionStatus(session: string): Promise<'active'|'absent'|'unknown'> {
    // reject unavailable host tmux access
    if (this.socket === undefined) return 'unknown';
    const result = await this.command(this.tmuxBinary, ['-S', this.socket, 'has-session', '-t', `=${session}`]);
    // recognize an existing session
    if (result.code === 0) return 'active';
    // preserve injected command compatibility and explicit absence
    if (result.code === 1 && (result.stderr === undefined || result.stderr.includes("can't find session"))) return 'absent';
    return 'unknown';
  }

  private async detached(worktree: Worktree, command: string): Promise<boolean> {
    return await this.detachedSession(worktree, command) !== undefined;
  }

  private async detachedSession(worktree: Worktree, command: string): Promise<string | undefined>;
  private async detachedSession(worktree: Worktree, command: string, action: StackAction): Promise<StackOperation | undefined>;
  // launch a detached command with optional durable output
  private async detachedSession(worktree: Worktree, command: string, action?: StackAction): Promise<string | StackOperation | undefined> {
    // require the host tmux socket
    if (this.socket === undefined) return undefined;
    const session = action === undefined ? `rac-stack-${worktree.id}-${randomBytes(9).toString('hex')}` : this.operationSession(worktree);
    const directory = worktreeHostRoot(worktree);
    let logFile: string | undefined;
    let hostLogFile: string | undefined;
    // prepare durable output for user-triggered actions
    if (action !== undefined && this.hostWorkspace !== undefined) {
      const name = `${worktree.id}-${randomBytes(9).toString('hex')}.log`;
      logFile = join('/workspace', '.data', 'stack-logs', name);
      hostLogFile = join(this.hostWorkspace, '.data', 'stack-logs', name);
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
    }
    const invocation = hostLogFile === undefined ? command : `{ ${command}; } > ${quote(hostLogFile)} 2>&1`;
    const script = `${hostPathExport()}cd -- ${quote(directory)} && ${invocation}`;
    const launched = (await this.command(this.tmuxBinary, ['-S', this.socket, 'new-session', '-d', '-s', session, '-c', directory, '/bin/bash', '-lc', script])).code === 0;
    // return simple status probes without operation metadata
    if (!launched || action === undefined) return launched ? session : undefined;
    return { action, session, startedAt: new Date().toISOString(), ...(logFile === undefined ? {} : { logFile }) };
  }
}
