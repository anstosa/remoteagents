import { createHash } from 'node:crypto';
import type { Agent, CleanupTarget, CleanupTargetKind, Pane, SocketRef } from '../domain/models.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import { ProcInspector, type HostProcess, type HostProcessInspector, type ProcessInspector } from '../discovery/processes.js';
import { adapters, paneExcluded } from '../adapters/registry.js';
import type { AgentKind, PaneScan } from '../adapters/types.js';
import { TmuxAdapter } from '../tmux/adapter.js';

type DiscoverySnapshot = { refresh(force?: boolean): Promise<Agent[]> };
type CleanupAction = { target: CleanupTarget; socket?: SocketRef; paneId?: string; pid?: number };

const opaqueId = (kind: CleanupTargetKind, identity: string) => `cleanup-${createHash('sha256').update(`${kind}\0${identity}`).digest('base64url').slice(0, 24)}`;
const paneIdentity = (pane: Pane) => `${pane.socket.fingerprint}:${pane.paneId}`;

export class CleanupService {
  private readonly dismissed = new Set<string>();
  private current = new Map<string, CleanupAction>();
  private scanInFlight?: Promise<CleanupTarget[]>;

  constructor(
    private readonly discovery: DiscoverySnapshot,
    private readonly finder: SocketFinder = new ProcSocketFinder(),
    private readonly tmux: Pick<TmuxAdapter, 'listPanes' | 'close' | 'terminateHostProcess'> = new TmuxAdapter(),
    private readonly processInspector: ProcessInspector & HostProcessInspector = new ProcInspector()
  ) {}

  pending(): CleanupTarget[] {
    return [...this.current.values()].filter(candidate => !this.dismissed.has(candidate.target.id)).map(candidate => candidate.target);
  }

  scan(): Promise<CleanupTarget[]> {
    if (this.scanInFlight !== undefined) return this.scanInFlight;
    const scan = this.discover().finally(() => {
      if (this.scanInFlight === scan) this.scanInFlight = undefined;
    });
    this.scanInFlight = scan;
    return scan;
  }

  async cleanup(targetIds: unknown): Promise<CleanupTarget[] | undefined> {
    if (!Array.isArray(targetIds) || targetIds.length > 500 || targetIds.some(id => typeof id !== 'string') || new Set(targetIds).size !== targetIds.length) return undefined;
    const pending = this.pending();
    const pendingIds = new Set(pending.map(target => target.id));
    if (targetIds.some(id => !pendingIds.has(id as string))) return undefined;
    const selected = new Set(targetIds as string[]);
    await Promise.all(pending.map(async target => {
      if (!selected.has(target.id)) {
        this.dismissed.add(target.id);
        return;
      }
      const action = this.current.get(target.id);
      if (action !== undefined && await this.execute(action).catch(() => false)) this.dismissed.add(target.id);
    }));
    return this.pending();
  }

  private async discover(): Promise<CleanupTarget[]> {
    const [sockets, agents, processes] = await Promise.all([
      this.finder.find(),
      this.discovery.refresh(true),
      this.processInspector.listProcesses()
    ]);
    const panes = (await Promise.all(sockets.map(socket => this.tmux.listPanes(socket)))).flat();
    const recognized = await Promise.all(panes.map(pane => this.processInspector.recognizeAgent(pane.pid)));
    const recognizedKind = new Map<string, AgentKind>();
    panes.forEach((pane, index) => { const agent = recognized[index]; if (agent !== undefined) recognizedKind.set(paneIdentity(pane), agent.kind); });
    const activeAgents = new Set(agents.map(agent => agent.id));
    const paneByPid = new Map(panes.map(pane => [pane.pid, pane]));
    const processByPid = new Map(processes.map(process => [process.pid, process]));
    const paneAncestor = (pid: number): Pane | undefined => {
      const seen = new Set<number>();
      let current = pid;
      while (current > 0 && seen.size < 256 && !seen.has(current)) {
        const pane = paneByPid.get(current);
        if (pane !== undefined) return pane;
        seen.add(current);
        current = processByPid.get(current)?.parentPid ?? 0;
      }
      return undefined;
    };
    // the agent-agnostic facts every Adapter classifies its panes against
    const scan: PaneScan = {
      panes,
      processes,
      identity: paneIdentity,
      sessionIdentity: pane => `${pane.socket.fingerprint}:${pane.sessionId}`,
      active: pane => activeAgents.has(paneIdentity(pane)),
      recognizedKind: pane => recognizedKind.get(paneIdentity(pane)),
      excluded: paneExcluded,
      paneAncestor
    };

    const candidates: CleanupAction[] = [];
    for (const pane of panes) {
      for (const adapter of adapters) {
        const classification = adapter.panes?.classify(pane, scan);
        if (classification === undefined) continue;
        candidates.push({ socket: pane.socket, paneId: pane.paneId, target: this.target(classification.kind, `${paneIdentity(pane)}:${pane.pid}`, classification.label, classification.detail) });
        break;
      }
    }

    const executorSocket = sockets[0];
    for (const process of processes) {
      for (const adapter of adapters) {
        const classification = adapter.panes?.classifyProcess?.(process, scan);
        if (classification === undefined) continue;
        candidates.push({
          target: this.target(classification.kind, `${process.pid}:${process.startTime}`, classification.label, classification.detail),
          ...(executorSocket === undefined ? {} : { socket: executorSocket }),
          pid: process.pid
        });
        break;
      }
    }

    const next = new Map(candidates.map(candidate => [candidate.target.id, candidate]));
    for (const id of this.dismissed) if (!next.has(id)) this.dismissed.delete(id);
    this.current = next;
    return this.pending();
  }

  private target(kind: CleanupTargetKind, identity: string, label: string, detail: string): CleanupTarget {
    return { id: opaqueId(kind, identity), kind, label, detail };
  }

  private async execute(action: CleanupAction): Promise<boolean> {
    if (action.socket === undefined) return false;
    if (action.paneId !== undefined) return await this.tmux.close(action.socket, action.paneId);
    if (action.pid !== undefined) return await this.tmux.terminateHostProcess(action.socket, action.pid);
    return false;
  }
}
