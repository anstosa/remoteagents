import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { stackActions, type StackAction, type StackProcessState, type Worktree } from '../domain/models.js';
import { worktreeById, worktreeHostRoot } from '../workspaces/resolver.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { run, tmuxLiteralArg, tmuxFormatLiteral } from '../tmux/command.js';
import { probeHolderSession, processNameOption, processPaneRole, processWorktreeOption } from '../tmux/stack-sessions.js';
import { availableSessionName, worktreeSessionName } from '../tmux/session-name.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// a tmux- and filesystem-safe token for one Worktree: its wire id `<projectId>:<realpath>`
// carries `/` and `:` that a session name or filename cannot, so name them by project id
// plus a short stable hash of the checkout path instead
const worktreeToken = (worktree: Pick<Worktree, 'projectId' | 'path'>) => `${worktree.projectId}-${createHash('sha256').update(worktree.path).digest('hex').slice(0, 12)}`;
type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;
type StackOperation = { action: StackAction; session: string; startedAt: string; completedAt?: string; logFile?: string };
export type StackOperationLog = { action: StackAction; active: boolean; startedAt: string; completedAt?: string; output: string };
// a Stack process's state beside the recent output its pane holds, and while it runs the
// pane's id, which "Open as Terminal" streams
export type StackProcessOutput = StackProcessState & { paneId?: string; output: string };
const maxStackLogBytes = 128 * 1024;
// a worktree `setup` runs once at creation and may install dependencies, so the creation
// flow waits far longer on it than on a status probe before giving up
const defaultSetupTiming = { timeoutMs: 5 * 60_000, pollMs: 250 };
// a status probe must be quick: the dashboard rebuilds ~once a second, so a probe that has
// not answered within this budget is abandoned (and its window killed) rather than waited on
const defaultStatusTiming = { timeoutMs: 2_000, pollMs: 100 };
// how long Stop waits for a Stack process to exit on Ctrl+C before it kills the window anyway
const defaultStopTiming = { timeoutMs: 10_000, pollMs: 250 };
// what the status-probe holder's placeholder window runs so the session never ends
const idleCommand = ['/bin/sh', '-c', 'while :; do sleep 3600; done'];
// What a new process window runs until it is tagged and respawned with the command. It
// ends by itself, so a console that dies mid-Start leaves a dead pane (reported exited,
// and rerun by the next Start) rather than a tagged idle one that reads as running forever.
const processPlaceholder = ['/bin/sh', '-c', 'sleep 30'];
export type StackState = { running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean; process?: StackProcessState };
// a Worktree's configured Stack process; the map holds at most one (config/schema.ts)
type StackProcess = { name: string; command: string };
const stackProcess = (worktree: Worktree): StackProcess | undefined => {
  const [entry] = Object.entries(worktree.commands?.processes ?? {});
  return entry === undefined ? undefined : { name: entry[0], command: entry[1] };
};
// one pane on the stack socket, as `list-panes -a` reports it: its session, the Place its
// session is the Workspace of, its console role, and the Stack process tags on its window
// (empty when untagged)
type ListedPane = { sessionId: string; windowId: string; paneId: string; place: string; role: string; name: string; worktree: string; dead: boolean; exitCode?: number };
// a listed process pane's state: live, or dead with the exit status tmux kept (absent after a signal)
const processStateOf = (pane: ListedPane, name: string): StackProcessState => pane.dead ? { name, state: 'exited', ...(pane.exitCode === undefined ? {} : { exitCode: pane.exitCode }) } : { name, state: 'running' };
// the actions a Stack process derives; any other action is a one-shot command (the web mirrors
// this list in stack-operations.ts)
const processActions: readonly StackAction[] = ['start', 'stop', 'restart'];

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

// keep only the newest bounded output, cut at a byte count like a log file's tail
const outputTail = (value: string): string => {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= maxStackLogBytes ? value : bytes.subarray(bytes.length - maxStackLogBytes).toString('utf8');
};

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
  // the Stack process action in flight per Worktree: its guard against an overlapping one,
  // and the operation the dashboard reports meanwhile. The processes themselves are never
  // recorded here — tmux holds them, and `stackPanes` finds them by their tags.
  private readonly processOperations = new Map<string, StackAction>();
  // one `list-panes` answers every Worktree's state during a dashboard build
  private processListing: Promise<ListedPane[] | undefined> | undefined;

  constructor(config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly command: Command = run, private readonly checkout: string = serverCheckout(), private readonly setupTiming: { timeoutMs: number; pollMs: number } = defaultSetupTiming, private readonly statusTiming: { timeoutMs: number; pollMs: number } = defaultStatusTiming, private readonly stopTiming: { timeoutMs: number; pollMs: number } = defaultStopTiming) {
    // status and log files live under the server's own checkout (see server-checkout.ts). A
    // native deployment runs commands on its own host, so that checkout is already the host
    // view; only a bridged one translates through the Project declared at the checkout.
    this.hostWorkspace = this.hostSocket === undefined ? checkout : serverCheckoutOnHost(config.projects, process.env.RAC_HOST_WORKSPACE, checkout);
  }

  // a Stack process derives its actions; everything else is a configured one-shot
  actions(worktree: Worktree): StackAction[] {
    const derived = stackProcess(worktree) === undefined ? [] : processActions;
    return stackActions.filter(action => derived.includes(action) || worktree.commands?.[action] !== undefined);
  }

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
    const session = `rac-setup-${token}`;
    const logFile = join(this.checkout, '.data', 'stack-logs', `setup-${token}.log`);
    const hostLogFile = join(this.hostWorkspace, '.data', 'stack-logs', `setup-${token}.log`);
    const markerFile = join(this.checkout, '.data', 'stack-status', `setup-${token}.exit`);
    const hostMarkerFile = join(this.hostWorkspace, '.data', 'stack-status', `setup-${token}.exit`);
    const directory = worktreeHostRoot(worktree);
    let launched = false;
    try {
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
      await mkdir(dirname(markerFile), { recursive: true, mode: 0o700 });
      // capture combined output to the log and the setup exit code (or a failed cd) to the marker
      const script = `${hostPathExport()}{ cd -- ${quote(directory)} && { ${command}; }; } > ${quote(hostLogFile)} 2>&1; printf '%s' "$?" > ${quote(hostMarkerFile)}`;
      launched = (await this.tmux(['new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(directory), '/bin/bash', '-lc', script])).code === 0;
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
    // once we stop waiting, kill the session so a setup that timed out or hung cannot linger on
    // the tmux server after we have reported it failed (a cleanly finished setup already exited)
    finally { if (launched) await this.tmux(['kill-session', '-t', `=${session}`]); await unlink(markerFile).catch(() => {}); }
  }

  // whether an operator-triggered stack operation is running for this Worktree — a Remove
  // blocker, so nothing is pulled out from under a build/migrate/etc. Only the exclusive
  // operation session counts; the shared `rac-stack-probes` holder whose windows run the status
  // probes is not an operation, so it never spuriously blocks Remove.
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

  // start one stack action: a Stack process's own action, or an exclusive one-shot operation
  async start(worktreeId: string, action: StackAction): Promise<'started'|'busy'|false> {
    const worktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
    const declared = worktree === undefined ? undefined : stackProcess(worktree);
    if (worktree !== undefined && declared !== undefined && processActions.includes(action)) return await this.processAction(worktree, declared, action);
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
        else if (action === 'stop') this.endStarting(worktree);
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

  // "Show <name> output": a Capture of the process pane (its full history, wrapped lines joined)
  // as plain text, cut to a stack log's tail, beside the process's state. A pane that no longer
  // exists has nothing to show. Only a live pane gives its id: tmux reports no cwd for a dead
  // one, so the Place pane listing, and with it the Terminal stream, leaves it out. Undefined
  // for an unknown Worktree or a name it does not configure; 'unavailable' when tmux cannot
  // answer, rather than throwing into the request.
  async processOutput(worktreeId: string, name: string): Promise<StackProcessOutput | 'unavailable' | undefined> {
    const worktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
    const declared = worktree === undefined ? undefined : stackProcess(worktree);
    if (worktree === undefined || declared?.name !== name) return undefined;
    const panes = await this.stackPanes();
    if (panes === undefined) return 'unavailable';
    const window = this.processWindow(panes, worktree, name);
    if (window === undefined) return { name, state: 'stopped', output: '' };
    const captured = await this.tmux(['capture-pane', '-p', '-J', '-S', '-', '-t', window.paneId]);
    // a window a Stop closed after the listing has stopped, like one never listed
    if (captured.code !== 0) return /can't find pane/u.test(captured.stderr ?? '') ? { name, state: 'stopped', output: '' } : 'unavailable';
    // a Capture pads the screen below the last line with blank rows
    return { ...processStateOf(window, name), ...(window.dead ? {} : { paneId: window.paneId }), output: outputTail(plainLog(captured.stdout).trimEnd()) };
  }

  // A Worktree with a Stack process reads `running` straight from the process pane and
  // never runs a `status` probe; that probe is for daemon-style stacks only.
  async state(worktree: Worktree): Promise<StackState> {
    const withProcess = stackProcess(worktree) !== undefined;
    const [process, probed, tunnel, operation] = await Promise.all([this.processState(worktree), withProcess ? undefined : this.running(worktree), this.tunnel(worktree), this.operation(worktree)]);
    const running = withProcess ? process === undefined ? undefined : process.state === 'running' : probed;
    const transition = this.transitions.get(worktree.id);
    // a process that is not running has nothing left to start, so it no longer reads as
    // Starting — a command that dies at once shows as down straight away
    if (transition !== undefined && (transition.expiresAt <= Date.now() || (transition.value === 'starting' && process !== undefined && process.state !== 'running'))) this.transitions.delete(worktree.id);
    const activeTransition = this.transitions.get(worktree.id)?.value;
    return { ...(running === undefined ? {} : { running }), ...(activeTransition === undefined ? {} : { transition: activeTransition }), ...(operation === undefined ? {} : { operation }), ...(tunnel === undefined ? {} : { tunnel }), ...(process === undefined ? {} : { process }) };
  }

  // a Worktree's Stack process as its tagged window shows it: live, dead with its exit code,
  // or no window at all. Undefined without a configured process, or when tmux cannot answer.
  private async processState(worktree: Worktree): Promise<StackProcessState | undefined> {
    const declared = stackProcess(worktree);
    if (declared === undefined) return undefined;
    const panes = await this.stackPanes();
    if (panes === undefined) return undefined;
    const window = this.processWindow(panes, worktree, declared.name);
    return window === undefined ? { name: declared.name, state: 'stopped' } : processStateOf(window, declared.name);
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
      let probe: string | undefined;
      try {
        const hostFile = join(this.hostWorkspace!, '.data', 'stack-status', name);
        await mkdir(dirname(containerFile), { recursive: true, mode: 0o700 });
        const script = `${hostPathExport()}cd -- ${quote(worktreeHostRoot(worktree))}; { ${command}; }; printf '%s' "$?" > ${quote(hostFile)}`;
        probe = await this.probeWindow(worktree, script);
        if (probe === undefined) return;
        const deadline = Date.now() + this.statusTiming.timeoutMs;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, this.statusTiming.pollMs));
          const result = await readFile(containerFile, 'utf8').catch(() => undefined);
          if (result === undefined) continue;
          this.statusCache.set(worktree.id, { value: result.trim() === '0', expiresAt: Date.now() + 30_000 });
          return;
        }
      } catch { /* Stack probing must never delay console traffic. */ }
      finally {
        // The probe window closes itself when its command exits (tmux `remain-on-exit off`),
        // so a fast status command leaves nothing behind. But a command that hangs, exceeds the
        // budget, or backgrounds a child that holds the pane keeps the window alive — and since
        // a timed-out probe never populates the cache, the next dashboard build (roughly every
        // second) spawns another one beside it. Killing the window here is what stops those
        // abandoned probes from piling up on the tmux server.
        if (probe !== undefined) await this.tmux(['kill-window', '-t', probe]);
        await unlink(containerFile).catch(() => {});
      }
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
    const processOperation = this.processOperations.get(worktree.id);
    if (processOperation !== undefined) return processOperation;
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

  // Run one Stack process action, serialized per Worktree by its own guard rather than the
  // one-shot exclusive session, so `build`/`migrate` still run beside a live process.
  // Restart stops the process but keeps its window, then reruns the command in that same pane,
  // so a Terminal open on it stays attached; it does not start a process it could not stop.
  private async processAction(worktree: Worktree, declared: StackProcess, action: StackAction): Promise<'started'|'busy'|false> {
    if (this.processOperations.has(worktree.id)) return 'busy';
    this.processOperations.set(worktree.id, action);
    try {
      const done = action === 'start' ? await this.startProcess(worktree, declared)
        : action === 'stop' ? await this.stopProcess(worktree, declared)
        : await this.stopProcess(worktree, declared, true) && await this.startProcess(worktree, declared, true);
      return done ? 'started' : false;
    } finally {
      this.processOperations.delete(worktree.id);
    }
  }

  // Start a Worktree's Stack process: a live one is left alone, a dead pane is respawned in
  // its window, and otherwise a new window opens in the Worktree's Workspace session — the
  // session marked as its Place, where its Agents and Terminals live — or, when it has none
  // yet, in a new session named and marked for it the way a launch makes one. The window is
  // tagged, set to remain on exit and its pane marked as a process while it still runs a
  // placeholder, and only then respawned with the command, so even a command that dies at
  // once leaves a findable dead pane.
  // A Restart's Start (`rerun`) respawns even a live pane: one that outlived Ctrl+C.
  private async startProcess(worktree: Worktree, declared: StackProcess, rerun = false): Promise<boolean> {
    // a listing already in flight may predate a window a just-finished Start opened
    const panes = await this.stackPanes(true);
    if (panes === undefined) return false;
    const existing = this.processWindow(panes, worktree, declared.name);
    if (existing !== undefined && !existing.dead && !rerun) return true;
    const directory = worktreeHostRoot(worktree);
    let pane = existing?.paneId;
    if (pane === undefined) {
      const workspace = panes.find(candidate => candidate.place === worktree.id)?.sessionId;
      const shape = ['-n', declared.name, '-c', tmuxFormatLiteral(directory), '-P', '-F', '#{window_id} #{pane_id}', ...processPlaceholder];
      const opened = workspace === undefined
        ? await this.tmux(['new-session', '-d', '-s', tmuxFormatLiteral(await availableSessionName(this.tmuxBinary, this.socketArgs, worktreeSessionName(directory), this.command)), ...shape])
        : await this.tmux(['new-window', '-d', '-t', `${workspace}:`, ...shape]);
      const [window, created] = opened.stdout.trim().split(' ');
      if (opened.code !== 0 || window === undefined || created === undefined) return false;
      pane = created;
      // a session made here becomes the Worktree's Workspace, marked through its pane id as a
      // launch marks one (a dotted session name is no tmux target)
      const marks = [...this.windowOption(window, 'remain-on-exit', 'on'), ';', ...this.windowOption(window, processWorktreeOption, worktree.path), ';', ...this.windowOption(window, processNameOption, declared.name), ';', 'set-option', '-p', '-t', pane, '@rac_role', processPaneRole, ...(workspace === undefined ? [';', 'set-option', '-t', pane, '@rac_place', tmuxLiteralArg(worktree.id)] : [])];
      if ((await this.tmux(marks)).code !== 0) { await this.tmux(['kill-window', '-t', window]); return false; }
    }
    const script = `${hostPathExport()}( cd -- ${quote(directory)} && { ${declared.command}; } )`;
    const respawned = await this.tmux(['respawn-pane', '-k', '-t', pane, '-c', tmuxFormatLiteral(directory), '/bin/bash', '-lc', script]);
    // a fresh window left on its placeholder would read as a running process, so remove it
    if (respawned.code !== 0) { if (existing === undefined) await this.tmux(['kill-window', '-t', pane]); return false; }
    this.transitions.set(worktree.id, { value: 'starting', expiresAt: Date.now() + 60_000 });
    return true;
  }

  // a Stop or Restart ends a Start's wait on the tunnel; a Migrating one-shot beside the
  // process is still under way
  private endStarting(worktree: Worktree) {
    if (this.transitions.get(worktree.id)?.value === 'starting') this.transitions.delete(worktree.id);
  }

  // Stop a Worktree's Stack process: a live pane is sent Ctrl+C (after leaving any mode that
  // would swallow it) and given up to the stop budget to exit, then its window is killed
  // whether or not it did; a dead pane's window is just killed, which clears the exited state.
  // No window is nothing to stop. Every window of the process goes, should a race or an
  // operator have left two, except the one a Restart `keep`s to rerun the command in. Killing
  // a window that is the last in its session closes the session and fires the operator's
  // `session-closed` hook; that is accepted for now, since a process lives in its Workspace
  // session beside the Place's Agents and Terminals (ADR 0009).
  private async stopProcess(worktree: Worktree, declared: StackProcess, keep = false): Promise<boolean> {
    const panes = await this.stackPanes(true);
    if (panes === undefined) return false;
    this.endStarting(worktree);
    const matching = this.processPanes(panes, worktree, declared.name);
    const kept = keep ? this.processWindow(panes, worktree, declared.name)?.windowId : undefined;
    const live = matching.filter(pane => !pane.dead);
    for (const pane of live) await this.tmux(['copy-mode', '-q', '-t', pane.paneId, ';', 'send-keys', '-t', pane.paneId, 'C-c']);
    const deadline = Date.now() + this.stopTiming.timeoutMs;
    while (live.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.stopTiming.pollMs));
      if ((await Promise.all(live.map(pane => this.paneDead(pane.paneId)))).every(Boolean)) break;
    }
    const killed = await Promise.all(matching.filter(pane => pane.windowId !== kept).map(pane => this.tmux(['kill-window', '-t', pane.windowId])));
    if (killed.every(result => result.code === 0)) return true;
    // a failed kill still stopped the process if its window is gone (the operator closed it)
    const remaining = await this.stackPanes(true);
    return remaining !== undefined && this.processPanes(remaining, worktree, declared.name).every(pane => pane.windowId === kept);
  }

  // whether a pane has exited; a pane that is gone altogether counts as exited, but a tmux that
  // cannot answer does not cut the graceful wait short
  private async paneDead(pane: string): Promise<boolean> {
    const shown = await this.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}']);
    return shown.code === 0 ? shown.stdout.trim() === '1' : /can't find pane/u.test(shown.stderr ?? '');
  }

  private windowOption(window: string, name: string, value: string): string[] { return ['set-option', '-w', '-t', window, name, tmuxLiteralArg(value)]; }

  // the process window for this Worktree and name, preferring a live one should a race or an
  // operator have left two; windows of other Worktrees or of names no longer configured are
  // orphans the stack controls ignore
  private processWindow(panes: ListedPane[], worktree: Worktree, name: string): ListedPane | undefined {
    const matching = this.processPanes(panes, worktree, name);
    return matching.find(pane => !pane.dead) ?? matching[0];
  }

  // every process pane tagged as this Worktree's process of this name, one per window; a pane
  // the operator split into a process window carries its tags but not the process role
  private processPanes(panes: ListedPane[], worktree: Worktree, name: string): ListedPane[] {
    return panes.filter(pane => pane.role === processPaneRole && pane.name === name && pane.worktree === worktree.path);
  }

  // Every pane on the stack socket, read from tmux on each call so a restarted console finds
  // the processes a previous instance started, in whichever session they live. Concurrent
  // dashboard readers share one `list-panes`; `fresh` skips joining one already in flight. A
  // tmux server that is not running holds no panes; undefined means tmux could not answer (it
  // could not run, or its socket refused us).
  private stackPanes(fresh = false): Promise<ListedPane[] | undefined> {
    const list = async (): Promise<ListedPane[] | undefined> => {
      const listed = await this.tmux(['list-panes', '-a', '-F', `#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{@rac_place}\t#{@rac_role}\t#{${processNameOption}}\t#{${processWorktreeOption}}`]);
      if (listed.code !== 0) return listed.code === 1 && (listed.stderr === undefined || /no server running/u.test(listed.stderr)) ? [] : undefined;
      return listed.stdout.split('\n').flatMap(line => {
        const [sessionId, windowId, paneId, dead, status, place, role, name, ...path] = line.split('\t');
        if (sessionId === undefined || windowId === undefined || paneId === undefined || name === undefined || paneId === '') return [];
        const exitCode = status === undefined || status === '' ? undefined : Number(status);
        return [{ sessionId, windowId, paneId, place: place ?? '', role: role ?? '', name, worktree: path.join('\t'), dead: dead === '1', ...(exitCode === undefined || Number.isNaN(exitCode) ? {} : { exitCode }) }];
      });
    };
    if (fresh) return list();
    this.processListing ??= list().finally(() => { this.processListing = undefined; });
    return this.processListing;
  }

  // Open a detached window in the status-probe holder session, creating the holder on first
  // use (or after a tmux server restart), and return the window id. A session per probe would
  // close a session on every refresh, and a closing session fires the operator's tmux
  // `session-closed` hook — a common `choose-tree` hook then opens the session picker over
  // whatever pane they (or an Agent) are using, where it also swallows a submitted prompt's
  // Enter. A closing window of a session that lives on fires nothing, so the holder keeps a
  // placeholder window and is never closed.
  private async holderWindow(args: string[]): Promise<string | undefined> {
    const open = () => this.tmux(['new-window', '-d', '-t', `=${probeHolderSession}:`, '-P', '-F', '#{window_id}', ...args]);
    let opened = await open();
    if (opened.code !== 0) {
      // no holder yet; a concurrent probe may win the race to create it, so just retry
      await this.tmux(['new-session', '-d', '-s', probeHolderSession, '-n', 'holder', ...idleCommand]);
      opened = await open();
    }
    const window = opened.stdout.trim();
    return opened.code === 0 && window !== '' ? window : undefined;
  }

  // run a status probe as a window of the probe holder and return its window id
  private async probeWindow(worktree: Worktree, script: string): Promise<string | undefined> {
    return await this.holderWindow(['-c', tmuxFormatLiteral(worktreeHostRoot(worktree)), '/bin/bash', '-lc', script]);
  }

  // launch a detached operation session with durable output when the host workspace resolves
  private async detachedSession(worktree: Worktree, command: string, action: StackAction): Promise<StackOperation | undefined> {
    const session = this.operationSession(worktree);
    const directory = worktreeHostRoot(worktree);
    let logFile: string | undefined;
    let hostLogFile: string | undefined;
    // prepare durable output for user-triggered actions
    if (this.hostWorkspace !== undefined) {
      const name = `${worktreeToken(worktree)}-${randomBytes(9).toString('hex')}.log`;
      logFile = join(this.checkout, '.data', 'stack-logs', name);
      hostLogFile = join(this.hostWorkspace, '.data', 'stack-logs', name);
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
    }
    const invocation = hostLogFile === undefined ? command : `{ ${command}; } > ${quote(hostLogFile)} 2>&1`;
    const script = `${hostPathExport()}cd -- ${quote(directory)} && ${invocation}`;
    const launched = (await this.tmux(['new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(directory), '/bin/bash', '-lc', script])).code === 0;
    if (!launched) return undefined;
    return { action, session, startedAt: new Date().toISOString(), ...(logFile === undefined ? {} : { logFile }) };
  }
}
