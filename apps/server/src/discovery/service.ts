import { lstat, realpath } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import type { Agent, Dashboard, Pane, SocketRef, Worktree } from '../domain/models.js';

export interface SocketFinder { find(): Promise<SocketRef[]>; }
export class ProcSocketFinder implements SocketFinder { async find(): Promise<SocketRef[]> { const uid = getuid?.(); if (uid === undefined) throw new Error('Linux UID is required'); const text = await (await import('node:fs/promises')).readFile('/proc/net/unix', 'utf8'); const rows = text.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 8 && parts[7]?.startsWith('/')); const sockets: SocketRef[] = []; for (const row of rows) { const path = row[7]!; try { const info = await lstat(path); if (!info.isSocket() || info.uid !== uid) continue; const canonical = await realpath(path).catch(() => path); const fingerprint = createHash('sha256').update(`${canonical}:${info.dev}:${info.ino}`).digest('base64url').slice(0, 22); sockets.push({ fingerprint, path: canonical, device: Number(info.dev), inode: Number(info.ino) }); } catch { } } return sockets; } }
async function gitMeta(path: string): Promise<{ workspace: string; branch?: string }> { const canonical = await realpath(path).catch(() => path); const root = await run('/usr/bin/git', ['-C', canonical, 'rev-parse', '--show-toplevel']); if (root.code !== 0) return { workspace: canonical }; const workspace = root.stdout.trim(); const branch = await run('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--short', 'HEAD']); if (branch.code === 0) return { workspace, branch: branch.stdout.trim() }; const sha = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']); return { workspace, branch: sha.code === 0 ? sha.stdout.trim() : undefined }; }
export class DiscoveryService {
  private generation = 0; private snapshot: Agent[] = [];
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector()) {}
  async refresh(): Promise<Agent[]> { const agents: Agent[] = []; for (const socket of await this.finder.find()) for (const pane of await this.tmux.listPanes(socket)) if (await this.processes.hasCodexDescendant(pane.pid)) { const meta = await gitMeta(pane.path); agents.push({ id: `${socket.fingerprint}:${pane.paneId}`, paneId: pane.paneId, sessionId: `${socket.fingerprint}:${pane.sessionId}`, socketFingerprint: socket.fingerprint, workspace: meta.workspace, branch: meta.branch, title: pane.title }); } this.snapshot = agents; this.generation++; return agents; }
  async target(id: string): Promise<{ agent: Agent; socket: SocketRef } | undefined> { await this.refresh(); const agent = this.snapshot.find(a => a.id === id); if (!agent) return undefined; const socket = (await this.finder.find()).find(s => s.fingerprint === agent.socketFingerprint); return socket ? { agent, socket } : undefined; }
  async dashboard(worktrees: Worktree[]): Promise<Dashboard> { const agents = await this.refresh(); const active = new Set(agents.map(a => a.workspace)); return { generation: this.generation, agents, worktrees: worktrees.filter(w => !active.has(w.identity)).map(w => ({ id: w.id, label: w.label, path: w.path, available: w.available })) }; }
}
