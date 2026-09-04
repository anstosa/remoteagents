import { lstat, open, realpath, readFile, readdir } from 'node:fs/promises';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import { PullRequestService } from '../pull-requests/service.js';
import { parseReportedAttention, resolveAttention } from '../adapters/attention.js';
import { adapterCapabilities, adapterFor, paneExcluded } from '../adapters/registry.js';
import { projectIdOf, worktreeMatchesWorkspace, worktreePathOf, worktreeWireId } from '../workspaces/resolver.js';
import { gitCommonDir, listWorktrees, type WorktreeEntry } from '../git/worktrees.js';
import { worktreeManagementAvailability } from '../worktrees/management.js';
import type { WorktreeLaunchStore } from '../worktrees/store.js';
import type { Adapter, AdapterConfigs, AttentionState, Conversation } from '../adapters/types.js';
import type { Agent, Dashboard, DashboardProject, DashboardWorktree, GitComparisonSummary, GitStatusChange, GitStatusSummary, GitUpstreamSummary, Project, SocketRef, Worktree } from '../domain/models.js';
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
export async function workspaceRoot(path: string): Promise<string> {
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
export class DiscoveryService {
  private generation = 0; private snapshot: Agent[] = [];
  private panePids = new Map<string, number>();
  // raw `#{pane_current_path}` per agent id, so the Adapter can match a sandboxed
  // pane's rollout by its working directory without readlink-ing its descriptors
  private paneCwds = new Map<string, string>();
  // reported @rac_attention per agent id, so the dashboard re-resolves with the question
  private paneReported = new Map<string, AttentionState>();
  private readonly serverStartedAt = Date.now();
  private refreshedAt = 0;
  private refreshInFlight?: Promise<Agent[]>;
  private socketSnapshot: SocketRef[] = [];
  private socketsRefreshedAt = 0;
  private socketRefreshInFlight?: Promise<SocketRef[]>;
  private dashboardSnapshot?: { refreshedAt: number; value: Dashboard };
  private dashboardRefreshInFlight?: Promise<Dashboard>;
  private worktreeSnapshot: Worktree[] = [];
  // the Prune-eligible checkout paths per Project (git's prunable entries plus console
  // records git lists nowhere), published atomically with the worktree snapshot (ADR 0003)
  private staleSnapshot = new Map<string, string[]>();
  private worktreesRefreshedAt = 0;
  private worktreesRefreshInFlight?: Promise<Worktree[]>;
  // bumped by invalidateWorktrees(); a scan that began under an older epoch read stale pins
  private worktreesEpoch = 0;
  private worktreesInFlightEpoch = -1;
  private readonly gitMetadata = new Map<string, { refreshedAt: number; value: GitMeta }>();
  private readonly gitMetadataInFlight = new Map<string, Promise<GitMeta>>();
  // a workspace's common git dir (null = none); Projects are static, so repository
  // membership never changes in a session — cache it so a persistent Scratch pane does
  // not re-spawn `git rev-parse` on every poll
  private readonly commonDirCache = new Map<string, string | null>();
  private static readonly refreshCacheMs = 2_000;
  private static readonly gitMetadataCacheMs = 30_000;
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector(), private readonly pullRequests = new PullRequestService(), private readonly adapters?: AdapterConfigs, private readonly projects: Project[] = [], private readonly pinStore?: Pick<WorktreeLaunchStore, 'pins'> & Partial<Pick<WorktreeLaunchStore, 'keys' | 'labels'>>, private readonly listWorktreesImpl: (path: string) => Promise<WorktreeEntry[] | undefined> = listWorktrees) {}
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
    const paneCwds = new Map<string, string>();
    const paneReported = new Map<string, AttentionState>();
    const agents: Agent[] = (await Promise.all(panes.filter(pane => !paneExcluded(pane)).map(async (pane): Promise<Agent | undefined> => {
      const recognized = await this.processes.recognizeAgent(pane.pid);
      if (recognized === undefined) {
        // a pane whose agent is gone must not keep a stale report; nothing else clears it
        if (pane.reportedAttention !== undefined || pane.reportedSession !== undefined || pane.reportedSandboxed !== undefined) void this.tmux.unsetReportedState(pane.socket, pane.paneId).catch(() => {});
        return undefined;
      }
      const workspace = await workspaceRoot(pane.path);
      const id = `${pane.socket.fingerprint}:${pane.paneId}`;
      panePids.set(id, pane.pid);
      paneCwds.set(id, pane.path);
      const reported = parseReportedAttention(pane.reportedAttention);
      if (reported !== undefined) paneReported.set(id, reported);
      const attention = resolveAttention({ kind: recognized.kind, title: pane.title, reported, hasQuestion: false });
      const conversationId = pane.reportedSession !== undefined && pane.reportedSession.length > 0 ? pane.reportedSession : undefined;
      return { id, paneId: pane.paneId, sessionId: `${pane.socket.fingerprint}:${pane.sessionId}`, socketFingerprint: pane.socket.fingerprint, workspace, title: pane.title, kind: recognized.kind, attention, ...(pane.reportedSandboxed === '1' ? { sandboxed: true } : {}), ...(conversationId === undefined ? {} : { conversationId }), ...(pane.displayLabel === undefined ? {} : { displayLabel: pane.displayLabel }) };
    }))).filter((agent): agent is Agent => agent !== undefined);
    this.snapshot = agents;
    this.panePids = panePids;
    this.paneCwds = paneCwds;
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

  // the OS pid backing one discovered pane, for the Adapter's rollout reads
  paneProcessId(id: string): number | undefined {
    return this.panePids.get(id);
  }

  // the pane's working directory, for the Adapter's privilege-free rollout match —
  // but only when no other discovered pane shares it, so a directory running two
  // agents fails closed to the TUI path rather than risk a sibling's rollout
  paneWorkingDirectory(id: string): string | undefined {
    const path = this.paneCwds.get(id);
    if (path === undefined) return undefined;
    let count = 0;
    for (const value of this.paneCwds.values()) if (value === path && (count += 1) > 1) return undefined;
    return path;
  }

  // resolve the selected pane, its Adapter, and the pane facts its conversation lives under
  private async conversationContext(id: string): Promise<{ agent: Agent; adapter: Adapter['conversations'] & {}; pane: { pid: number; cwd?: string } } | undefined> {
    const target = await this.target(id);
    if (target === undefined) return undefined;
    const conversations = adapterFor(target.agent.kind)?.conversations;
    const pid = this.panePids.get(target.agent.id);
    // require exact pane identity and an Adapter that resolves conversations
    if (conversations === undefined || pid === undefined) return undefined;
    // the unique working directory is the discover fallback for a confined service
    const cwd = this.paneWorkingDirectory(target.agent.id);
    return { agent: target.agent, adapter: conversations, pane: { pid, ...(cwd === undefined ? {} : { cwd }) } };
  }

  // the pane's own reported conversation id (`@rac_session`), when the Adapter accepts it
  private reportedConversationId(context: { agent: Agent; adapter: Adapter['conversations'] & {} }): string | undefined {
    const reported = context.agent.conversationId;
    return reported !== undefined && context.adapter.validId(reported) ? reported : undefined;
  }

  // the pane's current top-level conversation id: the reported `@rac_session`, else the Adapter's discovery
  async conversationId(id: string): Promise<string | undefined> {
    const context = await this.conversationContext(id);
    if (context === undefined) return undefined;
    return this.reportedConversationId(context) ?? (await context.adapter.discover?.(context.pane))?.id;
  }

  // the pane's current conversation with a title, for bookmarking
  async conversation(id: string): Promise<Conversation | undefined> {
    const context = await this.conversationContext(id);
    if (context === undefined) return undefined;
    const reported = this.reportedConversationId(context);
    // a reported id skips the fd-walk; its title is read by id (Codex) or by id and
    // the pane's working directory (Claude, whose transcript is keyed by cwd)
    if (reported !== undefined) {
      const title = await context.adapter.title?.(reported, context.pane.cwd);
      return { id: reported, ...(title === undefined ? {} : { title }) };
    }
    return await context.adapter.discover?.(context.pane);
  }
  // the Worktrees discovered from every available Project (bare and stale entries
  // excluded), pins folded in, cached with the 30s git-metadata window until a console
  // mutation invalidates it. Ordered config → Main first → Linked by branch (detached last).
  async worktrees(force = false): Promise<Worktree[]> {
    if (!force && Date.now() - this.worktreesRefreshedAt < DiscoveryService.gitMetadataCacheMs) return this.worktreeSnapshot;
    // coalesce only onto an in-flight scan begun since the last invalidation; a forced read
    // (a just-added worktree) or a post-invalidation read (a pin toggle) always scans fresh,
    // so a scan that started under the old pins can never satisfy it
    if (!force && this.worktreesRefreshInFlight !== undefined && this.worktreesInFlightEpoch === this.worktreesEpoch) return this.worktreesRefreshInFlight;
    const epoch = this.worktreesEpoch;
    const refresh = this.discoverWorktrees().then(({ worktrees, stale }) => {
      // publish only when this is still the newest scan and no invalidation raced it, so a
      // stale scan's completion never re-stamps the cache over a fresher pin/worktree set
      if (this.worktreesRefreshInFlight === refresh && this.worktreesEpoch === epoch) {
        this.worktreeSnapshot = worktrees;
        this.staleSnapshot = stale;
        this.worktreesRefreshedAt = Date.now();
      }
      return worktrees;
    }).finally(() => { if (this.worktreesRefreshInFlight === refresh) this.worktreesRefreshInFlight = undefined; });
    this.worktreesRefreshInFlight = refresh;
    this.worktreesInFlightEpoch = epoch;
    return refresh;
  }

  // the last discovered Worktree set, for the synchronous scope resolution the prompt
  // queue and its siblings run while handling a request
  // the current snapshot, replaced wholesale on refresh and never mutated — consumers
  // (the ProjectProxy target map) memoize by array identity, so keep it that way
  worktreesNow(): Worktree[] { return this.worktreeSnapshot; }

  // drop the Worktree and dashboard caches so the next read re-runs `git worktree list` and
  // rebuilds — called after a console add/remove and after a pin toggle. The epoch bump makes
  // any scan already in flight (which read the old pins) stale, so it cannot re-stamp the cache.
  invalidateWorktrees(): void { this.worktreesRefreshedAt = 0; this.worktreesEpoch += 1; this.dashboardSnapshot = undefined; }

  private async discoverWorktrees(): Promise<{ worktrees: Worktree[]; stale: Map<string, string[]> }> {
    const pins = (await this.pinStore?.pins()) ?? {};
    const labels = (await this.pinStore?.labels?.()) ?? {};
    // every stored key, so a worktree key git lists nowhere counts as an orphaned record
    const storeKeys = (await this.pinStore?.keys?.()) ?? [];
    const worktrees: Worktree[] = [];
    const stale = new Map<string, string[]>();
    for (const project of this.projects) {
      if (!project.available) continue;
      const entries = await this.listWorktreesImpl(project.path);
      if (entries === undefined) continue;
      // git lists the Main worktree first; a bare repository lists its bare entry first
      const mainPath = entries[0] !== undefined && !entries[0].bare ? await realpath(entries[0].path).catch(() => entries[0]!.path) : undefined;
      // every path git lists (prunable included), so a record matching a prunable checkout
      // is counted once (as a prunable entry) rather than again as an orphaned record
      const listedPaths = new Set(await Promise.all(entries.filter(entry => !entry.bare).map(entry => realpath(entry.path).catch(() => entry.path))));
      const stalePaths = [...await Promise.all(entries.filter(entry => !entry.bare && entry.prunable).map(entry => realpath(entry.path).catch(() => entry.path)))];
      for (const key of storeKeys) {
        if (projectIdOf(key) !== project.id) continue;
        const recordPath = worktreePathOf(key);
        if (recordPath !== undefined && !listedPaths.has(recordPath)) stalePaths.push(recordPath);
      }
      if (stalePaths.length > 0) stale.set(project.id, stalePaths);
      const usable: Worktree[] = [];
      for (const entry of entries) {
        // a bare entry is never a Worktree; a stale (prunable) one is hidden and kept
        if (entry.bare || entry.prunable) continue;
        const path = await realpath(entry.path).catch(() => entry.path);
        const main = path === mainPath;
        const id = worktreeWireId(project.id, path);
        const sha = entry.head === undefined ? undefined : entry.head.slice(0, 7);
        const generatedLabel = main ? project.label : entry.branch !== undefined ? `${project.label} · ${entry.branch}` : `${project.label} · ${sha ?? path.split('/').pop() ?? path}`;
        const customLabel = labels[id];
        const label = customLabel ?? generatedLabel;
        usable.push({
          id, projectId: project.id, label, ...(customLabel === undefined ? {} : { customLabel: true }), path, identity: path,
          ...(main && project.hostPath !== undefined ? { hostPath: project.hostPath } : {}),
          available: true, pinned: pins[id] ?? main, main, detached: entry.detached, locked: entry.locked,
          ...(entry.locked && entry.lockedReason !== undefined ? { lockedReason: entry.lockedReason } : {}),
          ...(entry.branch === undefined ? {} : { branch: entry.branch }),
          ...(entry.detached && sha !== undefined ? { sha } : {}),
          ...(project.commands === undefined ? {} : { commands: project.commands }),
          ...(project.newTask === undefined ? {} : { newTask: project.newTask }),
          push: project.push,
          ...(project.projectUrl === undefined ? {} : { projectUrl: project.projectUrl, ...(project.projectPort === undefined ? {} : { projectPort: project.projectPort }) })
        });
      }
      // Main first, then Linked ordered by branch with detached checkouts last
      usable.sort((left, right) => {
        if (left.main !== right.main) return left.main ? -1 : 1;
        if (left.detached !== right.detached) return left.detached ? 1 : -1;
        return (left.branch ?? left.sha ?? '').localeCompare(right.branch ?? right.sha ?? '');
      });
      worktrees.push(...usable);
    }
    return { worktrees, stale };
  }

  // build or reuse one dashboard view
  async dashboard(force = false): Promise<Dashboard> {
    const cached = this.dashboardSnapshot;
    // bypass cached state for lifecycle checks
    if (!force && cached !== undefined && Date.now() - cached.refreshedAt < DiscoveryService.refreshCacheMs) return cached.value;
    // reuse only ordinary dashboard refreshes
    if (!force && this.dashboardRefreshInFlight !== undefined) return this.dashboardRefreshInFlight;
    const value = this.buildDashboard(force)
      .then(dashboard => {
        this.dashboardSnapshot = { refreshedAt: Date.now(), value: dashboard };
        return dashboard;
      })
      .finally(() => {
        if (this.dashboardRefreshInFlight === value) this.dashboardRefreshInFlight = undefined;
      });
    this.dashboardRefreshInFlight = value;
    return value;
  }

  // enrich one discovered dashboard
  private async buildDashboard(force = false): Promise<Dashboard> {
    const discovered = await this.refresh(force);
    let worktrees = await this.worktrees(force);
    // a `git worktree add` from a terminal appears within one tick: if a live agent sits
    // in a checkout we do not know yet whose repository is a configured Project, re-scan once
    if (!force && await this.hasUnknownProjectWorktree(discovered, worktrees)) worktrees = await this.worktrees(true);
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
    const worktreeFor = (workspace: string) => worktrees.find(candidate => worktreeMatchesWorkspace(candidate, workspace));
    // the stable tab order: config → Main first → Linked by branch, as discovery sorted them
    const orderOf = new Map(worktrees.map((worktree, index) => [worktree.id, index] as const));
    const agents = await Promise.all(discovered.map(async (agent) => {
      // keep modal advisors outside configured worktree identity
      const worktree = isUpdateAdvisorLabel(agent.displayLabel) ? undefined : worktreeFor(agent.workspace);
      const workspace = worktree?.identity ?? agent.workspace;
      const [meta, question] = await Promise.all([
        metadataFor(workspace),
        adapterFor(agent.kind)?.questions?.pending?.(workspace, agent.paneId) ?? Promise.resolve(undefined)
      ]);
      const branch = meta.branch ?? agent.branch;
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, branch);
      const gitPrStatus = await gitPrComparisonForBase(meta, branch, pullRequest?.baseBranch);
      const details = worktree === undefined
        ? { ...agent, branch, ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }) }
        : { ...agent, branch, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), workspace: worktree.identity, projectId: worktree.projectId, worktreeId: worktree.id, ...(worktree.newTask === undefined ? {} : { newTaskConfigured: true }), push: worktree.push, ...(worktree.projectUrl === undefined ? {} : { projectUrl: worktree.projectUrl }) };
      // re-resolve now that a pending Inline question is known (precedence: reported → question → inferred → finished)
      const attention = resolveAttention({ kind: agent.kind, title: agent.title, reported: this.paneReported.get(agent.id), hasQuestion: question !== undefined });
      return { ...details, attention, ...(pullRequest === undefined ? {} : { pullRequest }), ...(question === undefined ? {} : { question }) };
    }));
    // a Worktree with a live agent carries its git metadata on the Agent; an idle one carries
    // it on the Worktree record, as the flat list used to. A modal advisor never claims one.
    const activeAgents = agents.filter(agent => !isUpdateAdvisorLabel(agent.displayLabel));
    const activeWorktreeIds = new Set(activeAgents.flatMap(agent => agent.worktreeId === undefined ? [] : [agent.worktreeId]));
    const worktreeViews = await Promise.all(worktrees.map(async (worktree): Promise<DashboardWorktree> => {
      const base: DashboardWorktree = { id: worktree.id, projectId: worktree.projectId, label: worktree.label, ...(worktree.customLabel === true ? { customLabel: true } : {}), path: worktree.path, available: worktree.available, pinned: worktree.pinned, main: worktree.main, detached: worktree.detached, locked: worktree.locked, order: orderOf.get(worktree.id) ?? 0, ...(worktree.branch === undefined ? {} : { branch: worktree.branch }), ...(worktree.sha === undefined ? {} : { sha: worktree.sha }), ...(worktree.projectUrl === undefined ? {} : { projectUrl: worktree.projectUrl }) };
      if (activeWorktreeIds.has(worktree.id)) return base;
      const meta = await metadataFor(worktree.identity);
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, meta.branch);
      const gitPrStatus = await gitPrComparisonForBase(meta, meta.branch, pullRequest?.baseBranch);
      return { ...base, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), ...(pullRequest === undefined ? {} : { pullRequest }) };
    }));
    const byProject = new Map<string, DashboardWorktree[]>();
    for (const view of worktreeViews) { const list = byProject.get(view.projectId) ?? []; list.push(view); byProject.set(view.projectId, list); }
    const projects: DashboardProject[] = this.projects.map(project => {
      const management = worktreeManagementAvailability(project);
      return { id: project.id, label: project.label, available: project.available, ...(project.unavailableReason === undefined ? {} : { unavailableReason: project.unavailableReason }), manageWorktrees: management.available, ...(management.reason === undefined ? {} : { manageWorktreesReason: management.reason }), stalePaths: this.staleSnapshot.get(project.id) ?? [], worktrees: byProject.get(project.id) ?? [] };
    });
    return { generation: this.generation, serverStartedAt: this.serverStartedAt, adapters: adapterCapabilities(this.adapters), agents, projects };
  }

  // whether a live agent sits in a checkout that is not a known Worktree but whose
  // repository is a configured Project — the signal to re-run discovery on demand
  private async hasUnknownProjectWorktree(agents: Agent[], worktrees: Worktree[]): Promise<boolean> {
    const seen = new Set<string>();
    for (const agent of agents) {
      if (isUpdateAdvisorLabel(agent.displayLabel) || seen.has(agent.workspace)) continue;
      seen.add(agent.workspace);
      if (worktrees.some(worktree => worktreeMatchesWorkspace(worktree, agent.workspace))) continue;
      const common = await this.cachedCommonDir(agent.workspace);
      if (common !== undefined && this.projects.some(project => project.available && project.identity === common)) return true;
    }
    return false;
  }

  // the workspace's common git dir, memoised (Projects are static, so the answer is stable)
  private async cachedCommonDir(workspace: string): Promise<string | undefined> {
    const cached = this.commonDirCache.get(workspace);
    if (cached !== undefined) return cached ?? undefined;
    const common = await gitCommonDir(workspace).catch(() => undefined);
    if (this.commonDirCache.size < 500) this.commonDirCache.set(workspace, common ?? null);
    return common;
  }
}
