import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import { PullRequestService } from '../pull-requests/service.js';
import type { Agent, Dashboard, Pane, SocketRef, Worktree } from '../domain/models.js';

export interface SocketFinder { find(): Promise<SocketRef[]>; }
export class ProcSocketFinder implements SocketFinder { async find(): Promise<SocketRef[]> { const uid = getuid?.(); if (uid === undefined) throw new Error('Linux UID is required'); const procRoot = process.env.RAC_HOST_PROC ?? '/proc'; const hostUid = process.env.RAC_HOST_UID ?? String(uid); const hostSocketRoot = process.env.RAC_HOST_TMUX_SOURCE ?? `/tmp/tmux-${hostUid}`; const mountedSocketRoot = process.env.RAC_HOST_TMUX_DIR; const unixSockets = process.env.RAC_HOST_UNIX_SOCKETS ?? `${procRoot}/net/unix`; const text = await (await import('node:fs/promises')).readFile(unixSockets, 'utf8'); const rows = text.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 8 && parts[7]?.startsWith('/')); const sockets: SocketRef[] = []; const seen = new Set<string>(); for (const row of rows) { const hostPath = row[7]!; const path = mountedSocketRoot !== undefined && hostPath.startsWith(`${hostSocketRoot}/`) ? join(mountedSocketRoot, hostPath.slice(hostSocketRoot.length)) : hostPath; try { const info = await lstat(path); if (!info.isSocket() || info.uid !== uid) continue; const canonical = await realpath(path).catch(() => path); const key = `${canonical}:${info.dev}:${info.ino}`; if (seen.has(key)) continue; seen.add(key); const fingerprint = createHash('sha256').update(key).digest('base64url').slice(0, 22); sockets.push({ fingerprint, path: canonical, device: Number(info.dev), inode: Number(info.ino) }); } catch { } } return sockets; } }
async function gitMeta(path: string): Promise<{ workspace: string; branch?: string }> { const canonical = await realpath(path).catch(() => path); const root = await run('/usr/bin/git', ['-C', canonical, 'rev-parse', '--show-toplevel']); if (root.code !== 0) return { workspace: canonical }; const workspace = root.stdout.trim(); const branch = await run('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--short', 'HEAD']); if (branch.code === 0) return { workspace, branch: branch.stdout.trim() }; const sha = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']); return { workspace, branch: sha.code === 0 ? sha.stdout.trim() : undefined }; }
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
export class DiscoveryService {
  private generation = 0; private snapshot: Agent[] = [];
  private refreshedAt = 0;
  private refreshInFlight?: Promise<Agent[]>;
  private static readonly refreshCacheMs = 2_000;
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector(), private readonly pullRequests = new PullRequestService()) {}
  async refresh(): Promise<Agent[]> {
    if (Date.now() - this.refreshedAt < DiscoveryService.refreshCacheMs) return this.snapshot;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.discover().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }
  private async discover(): Promise<Agent[]> {
    const sockets = await this.finder.find();
    const panes = (await Promise.all(sockets.map(async (socket) => (await this.tmux.listPanes(socket)).map(pane => ({ ...pane, socket }))))).flat();
    const agents: Agent[] = (await Promise.all(panes.map(async (pane): Promise<Agent | undefined> => {
      if (!await this.processes.hasCodexDescendant(pane.pid)) return undefined;
      const meta = await gitMeta(pane.path);
      return { id: `${pane.socket.fingerprint}:${pane.paneId}`, paneId: pane.paneId, sessionId: `${pane.socket.fingerprint}:${pane.sessionId}`, socketFingerprint: pane.socket.fingerprint, workspace: meta.workspace, ...(meta.branch === undefined ? {} : { branch: meta.branch }), title: pane.title };
    }))).filter((agent): agent is Agent => agent !== undefined);
    this.snapshot = agents;
    this.refreshedAt = Date.now();
    this.generation++;
    return agents;
  }
  async target(id: string): Promise<{ agent: Agent; socket: SocketRef } | undefined> { await this.refresh(); const agent = this.snapshot.find(a => a.id === id); if (!agent) return undefined; const socket = (await this.finder.find()).find(s => s.fingerprint === agent.socketFingerprint); return socket ? { agent, socket } : undefined; }
  async dashboard(worktrees: Worktree[]): Promise<Dashboard> { const discovered = await this.refresh(); const agents = await Promise.all(discovered.map(async (agent) => { const order = worktrees.findIndex((candidate) => agent.workspace === candidate.identity || agent.workspace === candidate.hostPath); const worktree = order < 0 ? undefined : worktrees[order]; const branch = agent.branch; const [pullRequestUrl, question] = await Promise.all([this.pullRequests.url(worktree?.identity ?? agent.workspace, branch), omxQuestion(worktree?.identity ?? agent.workspace, agent.paneId)]); const details = worktree === undefined ? { ...agent, branch } : { ...agent, branch, workspace: worktree.identity, worktreeId: worktree.id, worktreeLabel: worktree.label, worktreeOrder: order, projectUrl: worktree.projectUrl }; return { ...details, ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }), ...(question === undefined ? {} : { question }) }; })); const active = new Set(agents.map(a => a.workspace)); return { generation: this.generation, agents, worktrees: worktrees.filter(w => !active.has(w.identity)).map((w) => ({ id: w.id, label: w.label, path: w.path, available: w.available, pinned: w.pinned, projectUrl: w.projectUrl, order: worktrees.indexOf(w) })) }; }
}
