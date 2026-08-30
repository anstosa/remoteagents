import { lstat, open, realpath, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import { PullRequestService } from '../pull-requests/service.js';
import { parseReportedAttention, resolveAttention } from '../adapters/attention.js';
import { adapterCapabilities } from '../adapters/registry.js';
import type { AttentionState } from '../adapters/types.js';
import type { Agent, CodexSessionRef, Dashboard, GitComparisonSummary, GitStatusChange, GitStatusSummary, GitUpstreamSummary, Pane, SocketRef, Worktree } from '../domain/models.js';
import { classifyReviewPath } from '../git/change-classification.js';
import { isUpdateAdvisorLabel } from '../update-advisor.js';

export interface SocketFinder { find(): Promise<SocketRef[]>; }
export class ProcSocketFinder implements SocketFinder {
  private async socket(path: string, uid: number): Promise<SocketRef | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isSocket() || info.uid !== uid) return undefined;
      const canonical = await realpath(path).catch(() => path);
      const key = `${canonical}:${info.dev}:${info.ino}`;
      return { fingerprint: createHash('sha256').update(key).digest('base64url').slice(0, 22), path: canonical, device: Number(info.dev), inode: Number(info.ino) };
    } catch { return undefined; }
  }

  async find(): Promise<SocketRef[]> {
    const uid = getuid?.();
    if (uid === undefined) throw new Error('Linux UID is required');
    const mountedSocketRoot = process.env.RAC_HOST_TMUX_DIR;
    if (mountedSocketRoot !== undefined) {
      const entries = await readdir(mountedSocketRoot, { withFileTypes: true }).catch(() => []);
      const sockets = (await Promise.all(entries.map(entry => this.socket(join(mountedSocketRoot, entry.name), uid)))).filter((socket): socket is SocketRef => socket !== undefined);
      if (sockets.length > 0) return sockets;
    }

    const procRoot = process.env.RAC_HOST_PROC ?? '/proc';
    const hostUid = process.env.RAC_HOST_UID ?? String(uid);
    const hostSocketRoot = process.env.RAC_HOST_TMUX_SOURCE ?? `/tmp/tmux-${hostUid}`;
    const unixSockets = process.env.RAC_HOST_UNIX_SOCKETS ?? `${procRoot}/net/unix`;
    const text = await readFile(unixSockets, 'utf8');
    const sockets: SocketRef[] = [];
    const seen = new Set<string>();
    for (const row of text.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 8 && parts[7]?.startsWith('/'))) {
      const hostPath = row[7]!;
      // Probe only tmux's own socket directory. Other services' sockets accept
      // the connection but never answer the tmux handshake, so each one would
      // block list-panes until the command timeout.
      if (!hostPath.startsWith(`${hostSocketRoot}/`)) continue;
      const path = mountedSocketRoot !== undefined ? join(mountedSocketRoot, hostPath.slice(hostSocketRoot.length)) : hostPath;
      const socket = await this.socket(path, uid);
      if (socket === undefined) continue;
      const key = `${socket.path}:${socket.device}:${socket.inode}`;
      if (!seen.has(key)) { seen.add(key); sockets.push(socket); }
    }
    return sockets;
  }
}
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
type GitLineStats = { additions: number; deletions: number };
function gitNumstat(output: string): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = Number(record.slice(0, firstTab));
    const deletions = Number(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1;
      path = records[++index] ?? '';
    }
    if (!path || !Number.isInteger(additions) || !Number.isInteger(deletions)) continue;
    const current = stats.get(path);
    stats.set(path, { additions: (current?.additions ?? 0) + additions, deletions: (current?.deletions ?? 0) + deletions });
  }
  return stats;
}
export function gitStatusSummary(output: string, numstatOutputs: string[] = []): GitStatusSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = output.includes('\0');
  const records = output.split(nulDelimited ? '\0' : '\n');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    let path = record.slice(3);
    let originalPath: string | undefined;
    if (code[0] === 'R' || code[0] === 'C') {
      if (nulDelimited) originalPath = records[++index] || undefined;
      else {
        const separator = path.indexOf(' -> ');
        if (separator >= 0) {
          originalPath = path.slice(0, separator);
          path = path.slice(separator + 4);
        }
      }
    }
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = numstatOutputs.reduce((combined, numstat) => {
    for (const [path, stats] of gitNumstat(numstat)) {
      const current = combined.get(path);
      combined.set(path, { additions: (current?.additions ?? 0) + stats.additions, deletions: (current?.deletions ?? 0) + stats.deletions });
    }
    return combined;
  }, new Map<string, GitLineStats>());
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const summary: GitStatusSummary = { files: changes.length, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes };
  for (const { code } of changes) {
    if (code === '??') { summary.untracked += 1; continue; }
    if (conflictCodes.has(code)) { summary.conflicted += 1; continue; }
    if (code[0] !== ' ') summary.staged += 1;
    if (code[1] !== ' ') summary.unstaged += 1;
  }
  return summary;
}
// summarize changes from the merge base
export function gitComparisonSummary(base: string, nameStatusOutput: string, numstatOutput: string, untrackedChanges: GitStatusChange[] = []): GitComparisonSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = nameStatusOutput.includes('\0');
  const records = nameStatusOutput.split(nulDelimited ? '\0' : '\n');
  // parse name-status records
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // skip empty records
    if (!record) continue;
    let status: string;
    let path: string;
    let originalPath: string | undefined;
    // parse nul-delimited output
    if (nulDelimited) {
      status = record;
      path = records[++index] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = records[++index] ?? '';
      }
    } else {
      const parts = record.split('\t');
      status = parts[0] ?? '';
      path = parts[1] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = parts[2] ?? '';
      }
    }
    // ignore malformed records
    if (!status || !path) continue;
    const code = status[0] === 'U' ? 'UU' : `${status[0]} `;
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = gitNumstat(numstatOutput);
  // attach line totals
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const trackedPaths = new Set(changes.map(change => change.path));
  // include current untracked files
  for (const change of untrackedChanges) {
    // avoid duplicate paths
    if (!trackedPaths.has(change.path)) changes.push({ ...change });
  }
  return { base, files: changes.length, changes };
}
export async function addUntrackedLineStats(workspace: string, summary: GitStatusSummary, limits = { files: 256, bytes: 20 * 1024 * 1024, bytesPerFile: 5 * 1024 * 1024 }) {
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  for (const change of summary.changes ?? []) {
    if (change.code !== '??') continue;
    if (inspectedFiles >= limits.files || inspectedBytes >= limits.bytes) break;
    inspectedFiles += 1;
    try {
      const path = join(workspace, change.path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) { change.additions = 1; change.deletions = 0; continue; }
      if (!info.isFile() || info.size > limits.bytesPerFile || inspectedBytes + info.size > limits.bytes) continue;
      inspectedBytes += info.size;
      const handle = await open(path, 'r');
      const content = Buffer.allocUnsafe(info.size);
      let offset = 0;
      try {
        while (offset < content.length) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      const inspected = content.subarray(0, offset);
      if (inspected.subarray(0, 8_000).includes(0)) continue;
      let lines = 0;
      for (const byte of inspected) if (byte === 10) lines += 1;
      change.additions = lines + (inspected.length > 0 && inspected[inspected.length - 1] !== 10 ? 1 : 0);
      change.deletions = 0;
    } catch { /* The worktree may change between status and file inspection. */ }
  }
}
// compare the working tree with its merge target
async function gitPrComparison(workspace: string, branch: string | undefined, working: GitStatusSummary | undefined, preferredBase?: string, exactBase = false): Promise<GitComparisonSummary | undefined> {
  const [configured, remoteHead] = await Promise.all([
    branch === undefined ? Promise.resolve({ code: 1, stdout: '' }) : run('/usr/bin/git', ['-C', workspace, 'config', '--get', `branch.${branch}.gh-merge-base`]),
    run('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  ]);
  const configuredBase = configured.code === 0 ? configured.stdout.trim() : '';
  const preferred = preferredBase === undefined ? undefined : preferredBase.startsWith('origin/') || preferredBase.startsWith('refs/') ? preferredBase : `origin/${preferredBase}`;
  const candidates = (exactBase ? [preferred] : [
    preferred,
    configuredBase === '' ? undefined : configuredBase.includes('/') ? configuredBase : `origin/${configuredBase}`,
    remoteHead.code === 0 ? remoteHead.stdout.trim() : undefined,
    'origin/main',
    'origin/master'
  ]).filter((candidate): candidate is string => candidate !== undefined && candidate !== '');
  const seen = new Set<string>();
  // try merge-target fallbacks
  for (const candidate of candidates) {
    // skip duplicate fallbacks
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const mergeBase = await run('/usr/bin/git', ['-C', workspace, 'merge-base', 'HEAD', candidate]);
    // skip unavailable targets
    if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') continue;
    const base = mergeBase.stdout.trim();
    const [names, lines] = await Promise.all([
      run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--name-status', '-z', '--find-renames', base, '--']),
      run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', base, '--'])
    ]);
    // require both comparison views
    if (names.code !== 0 || lines.code !== 0) continue;
    const untracked = working?.changes?.filter(change => change.code === '??') ?? [];
    return gitComparisonSummary(candidate, names.stdout, lines.stdout, untracked);
  }
  return undefined;
}
type GitCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
// compare HEAD with the current branch's configured upstream
export async function gitUpstreamSummary(workspace: string, command: GitCommand = run): Promise<GitUpstreamSummary | undefined> {
  const upstream = await command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const name = upstream.code === 0 ? upstream.stdout.trim() : '';
  // detached, untracked, and gone upstreams do not produce a rebase prompt
  if (!name || /[\u0000-\u001f\u007f]/u.test(name) || name.length > 512) return undefined;
  const counts = await command('/usr/bin/git', ['-C', workspace, 'rev-list', '--left-right', '--count', `HEAD...${name}`]);
  const match = counts.code === 0 ? /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim()) : undefined;
  if (match == null) return undefined;
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return undefined;
  return { upstream: name, ahead, behind };
}
type GitMeta = { workspace: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary };
// prefer the pull request's actual base
async function gitPrComparisonForBase(meta: GitMeta, branch: string | undefined, baseBranch: string | undefined): Promise<GitComparisonSummary | undefined> {
  // keep the local fallback without PR metadata
  if (baseBranch === undefined) return meta.gitPrStatus;
  const preferredBase = baseBranch.startsWith('origin/') || baseBranch.startsWith('refs/') ? baseBranch : `origin/${baseBranch}`;
  // reuse matching comparisons
  if (meta.gitPrStatus?.base === preferredBase) return meta.gitPrStatus;
  return await gitPrComparison(meta.workspace, branch, meta.gitStatus, baseBranch, true);
}
// resolve one pane path to its repository root
async function workspaceRoot(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => path);
  const root = await run('/usr/bin/git', ['-C', canonical, 'rev-parse', '--show-toplevel']);
  return root.code === 0 ? root.stdout.trim() : canonical;
}
// collect branch metadata
async function gitMeta(path: string, rootKnown = false): Promise<GitMeta> {
  const workspace = rootKnown ? path : await workspaceRoot(path);
  const [symbolicBranch, status, diff] = await Promise.all([
    run('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--short', 'HEAD']),
    run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', 'HEAD', '--'])
  ]);
  let numstatOutputs = diff.code === 0 ? [diff.stdout] : [];
  if (diff.code !== 0) {
    const [staged, unstaged] = await Promise.all([
      run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--cached', '--numstat', '-z', '--']),
      run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', '--'])
    ]);
    numstatOutputs = [staged, unstaged].filter(result => result.code === 0).map(result => result.stdout);
  }
  const gitStatus = status.code === 0 ? gitStatusSummary(status.stdout, numstatOutputs) : undefined;
  // enrich untracked line counts
  if (gitStatus !== undefined) await addUntrackedLineStats(workspace, gitStatus);
  const branch = symbolicBranch.code === 0 ? symbolicBranch.stdout.trim() : undefined;
  const [gitPrStatus, gitUpstream] = await Promise.all([
    gitPrComparison(workspace, branch, gitStatus),
    branch === undefined ? Promise.resolve(undefined) : gitUpstreamSummary(workspace)
  ]);
  // return symbolic branches directly
  if (branch !== undefined) return { workspace, branch, ...(gitStatus === undefined ? {} : { gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(gitUpstream === undefined ? {} : { gitUpstream }) };
  const sha = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']);
  return { workspace, ...(sha.code === 0 ? { branch: sha.stdout.trim() } : {}), ...(gitStatus === undefined ? {} : { gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }) };
}
type OmxRecord = { kind?: unknown; question_id?: unknown; status?: unknown; question?: unknown; options?: unknown; questions?: unknown; renderer?: { target?: unknown; return_target?: unknown } };
const questionId = /^question-[A-Za-z0-9_.-]+$/;
const readQuestion = (raw: OmxRecord, paneId: string) => {
  if (raw.kind !== 'omx.question/v1' || (raw.status !== 'pending' && raw.status !== 'prompting') || raw.renderer?.return_target !== paneId || typeof raw.renderer.target !== 'string' || !/^%\d+$/.test(raw.renderer.target) || typeof raw.question_id !== 'string' || !questionId.test(raw.question_id)) return undefined;
  const first = Array.isArray(raw.questions) ? raw.questions[0] as { question?: unknown; options?: unknown } : undefined;
  const text = typeof first?.question === 'string' ? first.question : typeof raw.question === 'string' ? raw.question : undefined;
  const options = Array.isArray(first?.options) ? first.options : Array.isArray(raw.options) ? raw.options : [];
  const choices = options.map(option => option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string' ? (option as { label: string }).label : undefined).filter((value): value is string => value !== undefined);
  return text && choices.length >= 2 && choices.length <= 16 ? { id: raw.question_id, text, choices, paneId: raw.renderer.target } : undefined;
};
export async function omxQuestion(workspace: string, paneId: string) {
  const root = join(workspace, '.omx', 'state');
  const directories = [join(root, 'questions')];
  const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch(() => []);
  for (const session of sessions) if (session.isDirectory()) directories.push(join(root, 'sessions', session.name, 'questions'));
  for (const directory of directories) for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = await readFile(join(directory, entry.name), 'utf8').then(value => JSON.parse(value) as OmxRecord).catch(() => undefined);
    const question = parsed && readQuestion(parsed, paneId); if (question) return question;
  }
  return undefined;
}
const omxWorkerWorktree = /(?:^|\/)\.omx\/team\/[^/]+\/worktrees\/worker-\d+(?:\/|$)/u;
const omxWorkerStartup = /(?:^|\/)\.omx\/state\/team\/[^/]+\/runtime\/worker-\d+-startup\.sh(?:['"\s]|$)/u;
export const isOmxWorkerPane = (pane: Pane) => omxWorkerWorktree.test(pane.path) || omxWorkerStartup.test(pane.startCommand ?? '');
export class DiscoveryService {
  private generation = 0; private snapshot: Agent[] = [];
  private panePids = new Map<string, number>();
  // reported @rac_attention per agent id, so the dashboard re-resolves with the question
  private paneReported = new Map<string, AttentionState>();
  private readonly serverStartedAt = Date.now();
  private refreshedAt = 0;
  private refreshInFlight?: Promise<Agent[]>;
  private socketSnapshot: SocketRef[] = [];
  private socketsRefreshedAt = 0;
  private socketRefreshInFlight?: Promise<SocketRef[]>;
  private dashboardSnapshot?: { worktrees: Worktree[]; refreshedAt: number; value: Dashboard };
  private dashboardRefreshInFlight?: { worktrees: Worktree[]; value: Promise<Dashboard> };
  private readonly gitMetadata = new Map<string, { refreshedAt: number; value: GitMeta }>();
  private readonly gitMetadataInFlight = new Map<string, Promise<GitMeta>>();
  private static readonly refreshCacheMs = 2_000;
  private static readonly gitMetadataCacheMs = 30_000;
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector(), private readonly pullRequests = new PullRequestService()) {}
  // reuse socket discovery across adjacent requests
  private async sockets(force = false): Promise<SocketRef[]> {
    // serve the recent socket snapshot
    if (!force && Date.now() - this.socketsRefreshedAt < DiscoveryService.refreshCacheMs) return this.socketSnapshot;
    // coalesce concurrent socket scans
    if (this.socketRefreshInFlight !== undefined) return this.socketRefreshInFlight;
    const refresh = this.finder.find().then(sockets => {
      this.socketSnapshot = sockets;
      this.socketsRefreshedAt = Date.now();
      return sockets;
    }).finally(() => {
      // release only the active scan
      if (this.socketRefreshInFlight === refresh) this.socketRefreshInFlight = undefined;
    });
    this.socketRefreshInFlight = refresh;
    return refresh;
  }
  async refresh(force = false): Promise<Agent[]> {
    // finish older scans before a forced read
    if (force && this.refreshInFlight) await this.refreshInFlight;
    // reuse only ordinary fresh snapshots
    if (!force && Date.now() - this.refreshedAt < DiscoveryService.refreshCacheMs) return this.snapshot;
    // coalesce matching live scans
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.discover().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }
  private async discover(): Promise<Agent[]> {
    const sockets = await this.sockets(true);
    const panes = (await Promise.all(sockets.map(async (socket) => (await this.tmux.listPanes(socket)).map(pane => ({ ...pane, socket }))))).flat();
    const panePids = new Map<string, number>();
    const paneReported = new Map<string, AttentionState>();
    const agents: Agent[] = (await Promise.all(panes.filter(pane => !isOmxWorkerPane(pane)).map(async (pane): Promise<Agent | undefined> => {
      const recognized = await this.processes.recognizeAgent(pane.pid);
      if (recognized === undefined) {
        // a pane whose agent is gone must not keep a stale report; nothing else clears it
        if (pane.reportedAttention !== undefined || pane.reportedSession !== undefined || pane.reportedSandboxed !== undefined) void this.tmux.unsetReportedState(pane.socket, pane.paneId).catch(() => {});
        return undefined;
      }
      const workspace = await workspaceRoot(pane.path);
      const id = `${pane.socket.fingerprint}:${pane.paneId}`;
      panePids.set(id, pane.pid);
      const reported = parseReportedAttention(pane.reportedAttention);
      if (reported !== undefined) paneReported.set(id, reported);
      const attention = resolveAttention({ kind: recognized.kind, title: pane.title, reported, hasQuestion: false });
      const conversationId = pane.reportedSession !== undefined && pane.reportedSession.length > 0 ? pane.reportedSession : undefined;
      return { id, paneId: pane.paneId, sessionId: `${pane.socket.fingerprint}:${pane.sessionId}`, socketFingerprint: pane.socket.fingerprint, workspace, title: pane.title, kind: recognized.kind, attention, ...(pane.reportedSandboxed === '1' ? { sandboxed: true } : {}), ...(conversationId === undefined ? {} : { conversationId }), ...(pane.displayLabel === undefined ? {} : { displayLabel: pane.displayLabel }) };
    }))).filter((agent): agent is Agent => agent !== undefined);
    this.snapshot = agents;
    this.panePids = panePids;
    this.paneReported = paneReported;
    this.refreshedAt = Date.now();
    this.generation++;
    return agents;
  }
  // resolve known panes without blocking on dashboard enrichment
  async target(id: string, force = false): Promise<{ agent: Agent; socket: SocketRef } | undefined> {
    // refresh launch-sensitive pane state on demand
    if (force) await this.refresh(true);
    let agent = this.snapshot.find(candidate => candidate.id === id);
    // discover only targets absent from the runtime snapshot
    if (agent === undefined) {
      await this.refresh(true);
      agent = this.snapshot.find(candidate => candidate.id === id);
    }
    if (agent === undefined) return undefined;
    const socket = (await this.sockets()).find(candidate => candidate.fingerprint === agent!.socketFingerprint);
    return socket === undefined ? undefined : { agent, socket };
  }

  // resolve session files held by one selected agent pane
  async sessions(id: string): Promise<CodexSessionRef[] | undefined> {
    const target = await this.target(id);
    const pid = target === undefined ? undefined : this.panePids.get(target.agent.id);
    // require exact pane and process inspection support
    if (pid === undefined || this.processes.sessionsForDescendants === undefined) return undefined;
    return await this.processes.sessionsForDescendants(pid);
  }
  // build or reuse one dashboard view
  async dashboard(worktrees: Worktree[], force = false): Promise<Dashboard> {
    const cached = this.dashboardSnapshot;
    // bypass cached state for lifecycle checks
    if (!force && cached?.worktrees === worktrees && Date.now() - cached.refreshedAt < DiscoveryService.refreshCacheMs) return cached.value;
    const active = this.dashboardRefreshInFlight;
    // reuse only ordinary dashboard refreshes
    if (!force && active?.worktrees === worktrees) return active.value;
    const value = this.buildDashboard(worktrees, force)
      .then(dashboard => {
        this.dashboardSnapshot = { worktrees, refreshedAt: Date.now(), value: dashboard };
        return dashboard;
      })
      .finally(() => {
        if (this.dashboardRefreshInFlight?.value === value) this.dashboardRefreshInFlight = undefined;
      });
    this.dashboardRefreshInFlight = { worktrees, value };
    return value;
  }

  // enrich one discovered dashboard
  private async buildDashboard(worktrees: Worktree[], force = false): Promise<Dashboard> {
    const discovered = await this.refresh(force);
    const metadataFor = (workspace: string) => {
      const cached = this.gitMetadata.get(workspace);
      // reuse recent Git state across frequent dashboard polls
      if (cached !== undefined && Date.now() - cached.refreshedAt < DiscoveryService.gitMetadataCacheMs) return Promise.resolve(cached.value);
      const active = this.gitMetadataInFlight.get(workspace);
      // coalesce matching repository scans
      if (active !== undefined) return active;
      const value = gitMeta(workspace, true).then(meta => {
        this.gitMetadata.set(workspace, { refreshedAt: Date.now(), value: meta });
        return meta;
      }).finally(() => {
        // release only the matching scan
        if (this.gitMetadataInFlight.get(workspace) === value) this.gitMetadataInFlight.delete(workspace);
      });
      this.gitMetadataInFlight.set(workspace, value);
      // refresh expired metadata without delaying console traffic
      if (cached !== undefined) return Promise.resolve(cached.value);
      return value;
    };
    const agents = await Promise.all(discovered.map(async (agent) => {
      // keep modal advisors outside configured worktree identity
      const order = isUpdateAdvisorLabel(agent.displayLabel) ? -1 : worktrees.findIndex(candidate => agent.workspace === candidate.identity || agent.workspace === candidate.hostPath);
      const worktree = order < 0 ? undefined : worktrees[order];
      const workspace = worktree?.identity ?? agent.workspace;
      const [meta, question] = await Promise.all([
        metadataFor(workspace),
        omxQuestion(workspace, agent.paneId)
      ]);
      const branch = meta.branch ?? agent.branch;
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, branch);
      const gitPrStatus = await gitPrComparisonForBase(meta, branch, pullRequest?.baseBranch);
      const details = worktree === undefined
        ? { ...agent, branch, ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }) }
        : { ...agent, branch, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), workspace: worktree.identity, worktreeId: worktree.id, worktreeLabel: worktree.label, worktreeOrder: order, ...(worktree.newTask === undefined ? {} : { newTaskConfigured: true }), push: worktree.push, projectUrl: worktree.projectUrl };
      // re-resolve now that a pending Inline question is known (precedence: reported → question → inferred → finished)
      const attention = resolveAttention({ kind: agent.kind, title: agent.title, reported: this.paneReported.get(agent.id), hasQuestion: question !== undefined });
      return { ...details, attention, ...(pullRequest === undefined ? {} : { pullRequest }), ...(question === undefined ? {} : { question }) };
    }));
    // do not let a modal advisor hide the configured repository placeholder
    const active = new Set(agents.filter(agent => !isUpdateAdvisorLabel(agent.displayLabel)).map(agent => agent.workspace));
    const inactive = await Promise.all(worktrees.filter(worktree => !active.has(worktree.identity)).map(async (worktree) => {
      const meta = await metadataFor(worktree.identity);
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, meta.branch);
      const gitPrStatus = await gitPrComparisonForBase(meta, meta.branch, pullRequest?.baseBranch);
      return { id: worktree.id, label: worktree.label, path: worktree.path, available: worktree.available, pinned: worktree.pinned, projectUrl: worktree.projectUrl, order: worktrees.indexOf(worktree), ...(meta.branch === undefined ? {} : { branch: meta.branch }), ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), ...(pullRequest === undefined ? {} : { pullRequest }) };
    }));
    return { generation: this.generation, serverStartedAt: this.serverStartedAt, adapters: adapterCapabilities(), agents, worktrees: inactive };
  }
}
