import { lstat, open, realpath, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import { PullRequestService } from '../pull-requests/service.js';
import type { Agent, Dashboard, GitStatusChange, GitStatusSummary, Pane, SocketRef, Worktree } from '../domain/models.js';

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
      const path = mountedSocketRoot !== undefined && hostPath.startsWith(`${hostSocketRoot}/`) ? join(mountedSocketRoot, hostPath.slice(hostSocketRoot.length)) : hostPath;
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
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }) });
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
async function gitMeta(path: string): Promise<{ workspace: string; branch?: string; gitStatus?: GitStatusSummary }> {
  const canonical = await realpath(path).catch(() => path);
  const root = await run('/usr/bin/git', ['-C', canonical, 'rev-parse', '--show-toplevel']);
  if (root.code !== 0) return { workspace: canonical };
  const workspace = root.stdout.trim();
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
  if (gitStatus !== undefined) await addUntrackedLineStats(workspace, gitStatus);
  if (symbolicBranch.code === 0) return { workspace, branch: symbolicBranch.stdout.trim(), ...(gitStatus === undefined ? {} : { gitStatus }) };
  const sha = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']);
  return { workspace, ...(sha.code === 0 ? { branch: sha.stdout.trim() } : {}), ...(gitStatus === undefined ? {} : { gitStatus }) };
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
  private refreshedAt = 0;
  private refreshInFlight?: Promise<Agent[]>;
  private dashboardSnapshot?: { worktrees: Worktree[]; refreshedAt: number; value: Dashboard };
  private dashboardRefreshInFlight?: { worktrees: Worktree[]; value: Promise<Dashboard> };
  private static readonly refreshCacheMs = 2_000;
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector(), private readonly pullRequests = new PullRequestService()) {}
  async refresh(force = false): Promise<Agent[]> {
    if (!force && Date.now() - this.refreshedAt < DiscoveryService.refreshCacheMs) return this.snapshot;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.discover().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }
  private async discover(): Promise<Agent[]> {
    const sockets = await this.finder.find();
    const panes = (await Promise.all(sockets.map(async (socket) => (await this.tmux.listPanes(socket)).map(pane => ({ ...pane, socket }))))).flat();
    const agents: Agent[] = (await Promise.all(panes.filter(pane => !isOmxWorkerPane(pane)).map(async (pane): Promise<Agent | undefined> => {
      if (!await this.processes.hasCodexDescendant(pane.pid)) return undefined;
      const meta = await gitMeta(pane.path);
      return { id: `${pane.socket.fingerprint}:${pane.paneId}`, paneId: pane.paneId, sessionId: `${pane.socket.fingerprint}:${pane.sessionId}`, socketFingerprint: pane.socket.fingerprint, workspace: meta.workspace, ...(meta.branch === undefined ? {} : { branch: meta.branch }), ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), title: pane.title, ...(pane.displayLabel === undefined ? {} : { displayLabel: pane.displayLabel }) };
    }))).filter((agent): agent is Agent => agent !== undefined);
    this.snapshot = agents;
    this.refreshedAt = Date.now();
    this.generation++;
    return agents;
  }
  async target(id: string): Promise<{ agent: Agent; socket: SocketRef } | undefined> { await this.refresh(); const agent = this.snapshot.find(a => a.id === id); if (!agent) return undefined; const socket = (await this.finder.find()).find(s => s.fingerprint === agent.socketFingerprint); return socket ? { agent, socket } : undefined; }
  async dashboard(worktrees: Worktree[]): Promise<Dashboard> {
    const cached = this.dashboardSnapshot;
    if (cached?.worktrees === worktrees && Date.now() - cached.refreshedAt < DiscoveryService.refreshCacheMs) return cached.value;
    const active = this.dashboardRefreshInFlight;
    if (active?.worktrees === worktrees) return active.value;
    const value = this.buildDashboard(worktrees)
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

  private async buildDashboard(worktrees: Worktree[]): Promise<Dashboard> {
    const discovered = await this.refresh();
    const agents = await Promise.all(discovered.map(async (agent) => {
      const order = worktrees.findIndex(candidate => agent.workspace === candidate.identity || agent.workspace === candidate.hostPath);
      const worktree = order < 0 ? undefined : worktrees[order];
      const workspace = worktree?.identity ?? agent.workspace;
      const [meta, question] = await Promise.all([
        worktree === undefined ? Promise.resolve({ workspace, branch: agent.branch, gitStatus: agent.gitStatus }) : gitMeta(workspace),
        omxQuestion(workspace, agent.paneId)
      ]);
      const branch = meta.branch ?? agent.branch;
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, branch);
      const details = worktree === undefined
        ? { ...agent, branch }
        : { ...agent, branch, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), workspace: worktree.identity, worktreeId: worktree.id, worktreeLabel: worktree.label, worktreeOrder: order, ...(worktree.newTask === undefined ? {} : { newTaskConfigured: true }), push: worktree.push, projectUrl: worktree.projectUrl };
      return { ...details, ...(pullRequest === undefined ? {} : { pullRequest }), ...(question === undefined ? {} : { question }) };
    }));
    const active = new Set(agents.map(agent => agent.workspace));
    const inactive = await Promise.all(worktrees.filter(worktree => !active.has(worktree.identity)).map(async (worktree) => {
      const meta = await gitMeta(worktree.identity);
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, meta.branch);
      return { id: worktree.id, label: worktree.label, path: worktree.path, available: worktree.available, pinned: worktree.pinned, projectUrl: worktree.projectUrl, order: worktrees.indexOf(worktree), ...(meta.branch === undefined ? {} : { branch: meta.branch }), ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(pullRequest === undefined ? {} : { pullRequest }) };
    }));
    return { generation: this.generation, agents, worktrees: inactive };
  }
}
