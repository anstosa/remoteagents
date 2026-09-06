import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { stackActions, type StackAction, type Worktree } from '../domain/models.js';
import { worktreeById, worktreeHostRoot } from '../workspaces/resolver.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { run } from '../tmux/command.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// a tmux- and filesystem-safe token for one Worktree: its wire id `<projectId>:<realpath>`
// carries `/` and `:` that a session name or filename cannot, so name them by project id
// plus a short stable hash of the checkout path instead
const worktreeToken = (worktree: Pick<Worktree, 'projectId' | 'path'>) => `${worktree.projectId}-${createHash('sha256').update(worktree.path).digest('hex').slice(0, 12)}`;
type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;
type StackOperation = { action: StackAction; session: string; startedAt: string; completedAt?: string; logFile?: string };
export type StackOperationLog = { action: StackAction; active: boolean; startedAt: string; completedAt?: string; output: string };
const maxStackLogBytes = 128 * 1024;
// a worktree `setup` runs once at creation and may install dependencies, so the creation
// flow waits far longer on it than on a status probe before giving up
const defaultSetupTiming = { timeoutMs: 5 * 60_000, pollMs: 250 };

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
  // the host tmux socket when the console runs in a container and reaches tmux through a
  // mounted socket dir; undefined in a native (systemd/dev) deployment, where tmux runs as
  // the same user and stack sessions live on its default socket. Like launch/service.ts, an
  // undefined socket means "run on tmux's default socket", not "disable stack commands".
  private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly socketArgs = this.hostSocket === undefined ? [] : ['-S', this.hostSocket];
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly hostWorkspace: string | undefined;
  private readonly statusCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly statusRefreshes = new Map<string, Promise<void>>();
  private readonly transitions = new Map<string, { value: 'starting'|'migrating'; expiresAt: number }>();
  private readonly operations = new Map<string, StackOperation>();
  private readonly launchingOperations = new Set<string>();
  private readonly tunnelCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly tunnelRefreshes = new Map<string, Promise<void>>();

  constructor(config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly command: Command = run, private readonly checkout: string = serverCheckout(), private readonly setupTiming: { timeoutMs: number; pollMs: number } = defaultSetupTiming) {
    // status and log files live under the server's own checkout (see server-checkout.ts). A
    // native deployment runs commands on its own host, so that checkout is already the host
    // view; only a bridged one translates through the Project declared at the checkout.
    this.hostWorkspace = this.hostSocket === undefined ? checkout : serverCheckoutOnHost(config.projects, process.env.RAC_HOST_WORKSPACE, checkout);
  }

  actions(worktree: Worktree): StackAction[] { return stackActions.filter(action => worktree.commands?.[action] !== undefined); }

  // one entry point for every tmux call: prepend the socket selector (empty on the default
  // socket) and never let a spawn failure escape into a request handler — a tmux that cannot
  // run is reported as a failed command (code -1), so probes and Remove-blocker checks fail
  // safe rather than 500 the request
  private async tmux(args: string[]): Promise<{ code: number; stdout: string; stderr?: string }> {
    return await this.command(this.tmuxBinary, [...this.socketArgs, ...args]).catch(() => ({ code: -1, stdout: '' }));
  }

  // Run a Worktree's configured `commands.setup` once, when the console creates the
  // Worktree, before any agent launches — the operator's chance to install dependencies or
  // link secrets so the fresh checkout can build. It runs detached on tmux (the host socket
  // when bridged, else the default socket) like a stack command (worktree host root,
  // `/bin/bash -lc`, host PATH), streaming its
  // combined output to a log under `.data/stack-logs`, and this call blocks until the
  // command finishes: the exit status (a failed `cd` included) is written to a marker under
  // `.data/stack-status` that the console-side loop polls, bounded by a timeout so a hung
  // setup can never wedge creation. A successful run's log is discarded; only a failed run
  // keeps its log, so the store stays bounded and the returned `log` (present on failure)
  // points the host operator at the output. A Worktree with no `setup`, or a deployment whose
  // server checkout resolves to no host path, is a no-op success so the creation flow never
  // gates a launch it cannot prepare. Never throws; a launch failure, timeout, or non-zero
  // exit reports `ok: false`.
  async runSetup(worktree: Worktree): Promise<{ ok: boolean; log?: string }> {
    const command = worktree.commands?.setup;
    if (command === undefined || this.hostWorkspace === undefined) return { ok: true };
    const token = `${worktreeToken(worktree)}-${randomBytes(9).toString('hex')}`;
    const logFile = join(this.checkout, '.data', 'stack-logs', `setup-${token}.log`);
    const hostLogFile = join(this.hostWorkspace, '.data', 'stack-logs', `setup-${token}.log`);
    const markerFile = join(this.checkout, '.data', 'stack-status', `setup-${token}.exit`);
    const hostMarkerFile = join(this.hostWorkspace, '.data', 'stack-status', `setup-${token}.exit`);
    const directory = worktreeHostRoot(worktree);
    try {
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
      await mkdir(dirname(markerFile), { recursive: true, mode: 0o700 });
      // capture combined output to the log and the setup exit code (or a failed cd) to the marker
      const script = `${hostPathExport()}{ cd -- ${quote(directory)} && { ${command}; }; } > ${quote(hostLogFile)} 2>&1; printf '%s' "$?" > ${quote(hostMarkerFile)}`;
      const launched = (await this.tmux(['new-session', '-d', '-s', `rac-setup-${token}`, '-c', directory, '/bin/bash', '-lc', script])).code === 0;
      if (!launched) return { ok: false, log: logFile };
      const deadline = Date.now() + this.setupTiming.timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, this.setupTiming.pollMs));
        const marker = await readFile(markerFile, 'utf8').catch(() => undefined);
        if (marker === undefined) continue;
        // a successful setup's output has no further use; keep only a failed run's log
        if (marker.trim() === '0') { await unlink(logFile).catch(() => {}); return { ok: true }; }
        return { ok: false, log: logFile };
      }
      // a setup that never finished within the budget is a failure, not a silent hang
      return { ok: false, log: logFile };
    } catch { return { ok: false, log: logFile }; }
    finally { await unlink(markerFile).catch(() => {}); }
  }

  // whether an operator-triggered stack operation is running for this Worktree — a Remove
  // blocker, so nothing is pulled out from under a build/migrate/etc. Only the exclusive
  // operation session counts; the transient `rac-stack-<token>-<hex>` status probes that fire
  // on every dashboard build are not operations, so they never spuriously block Remove.
  // The session list comes from the host tmux socket when bridged, else tmux's default socket.
  async sessionRunning(worktree: Worktree): Promise<boolean> {
    const listed = await this.tmux(['list-sessions', '-F', '#{session_name}']);
    if (listed.code !== 0) return false;
    const prefix = `rac-stack-${worktreeToken(worktree)}-`;
    return listed.stdout.split('\n').some(name => { const trimmed = name.trim(); return trimmed.startsWith(prefix) && trimmed.endsWith('-exclusive'); });
  }

  async run(worktreeId: string, action: StackAction): Promise<boolean> {
    return await this.start(worktreeId, action) === 'started';
  }

  // start one exclusive stack operation
  async start(worktreeId: string, action: StackAction): Promise<'started'|'busy'|false> {
    const worktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
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
    const worktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
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
    if (command === undefined || this.hostWorkspace === undefined) return undefined;
    const cached = this.statusCache.get(worktree.id);
    if (cached === undefined || cached.expiresAt <= Date.now()) void this.refreshStatus(worktree, command);
    return cached?.value;
  }

  private refreshStatus(worktree: Worktree, command: string): Promise<void> {
    const active = this.statusRefreshes.get(worktree.id);
    if (active !== undefined) return active;
    const refresh = (async () => {
      const name = `stack-${worktreeToken(worktree)}-${randomBytes(6).toString('hex')}`;
      const containerFile = join(this.checkout, '.data', 'stack-status', name);
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
    if (operation.completedAt !== undefined) return false;
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
    return `rac-stack-${worktreeToken(worktree)}-${actionLabel}-exclusive`;
  }

  // distinguish a missing session from a broken tmux probe
  private async sessionStatus(session: string): Promise<'active'|'absent'|'unknown'> {
    const result = await this.tmux(['has-session', '-t', `=${session}`]);
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
    const session = action === undefined ? `rac-stack-${worktreeToken(worktree)}-${randomBytes(9).toString('hex')}` : this.operationSession(worktree);
    const directory = worktreeHostRoot(worktree);
    let logFile: string | undefined;
    let hostLogFile: string | undefined;
    // prepare durable output for user-triggered actions
    if (action !== undefined && this.hostWorkspace !== undefined) {
      const name = `${worktreeToken(worktree)}-${randomBytes(9).toString('hex')}.log`;
      logFile = join(this.checkout, '.data', 'stack-logs', name);
      hostLogFile = join(this.hostWorkspace, '.data', 'stack-logs', name);
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
    }
    const invocation = hostLogFile === undefined ? command : `{ ${command}; } > ${quote(hostLogFile)} 2>&1`;
    const script = `${hostPathExport()}cd -- ${quote(directory)} && ${invocation}`;
    const launched = (await this.tmux(['new-session', '-d', '-s', session, '-c', directory, '/bin/bash', '-lc', script])).code === 0;
    // return simple status probes without operation metadata
    if (!launched || action === undefined) return launched ? session : undefined;
    return { action, session, startedAt: new Date().toISOString(), ...(logFile === undefined ? {} : { logFile }) };
  }
}
