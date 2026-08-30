import { createHash } from 'node:crypto';
import type { Agent, CleanupTarget, CleanupTargetKind, Pane, SocketRef } from '../domain/models.js';
import { ProcSocketFinder, isOmxWorkerPane, type SocketFinder } from '../discovery/service.js';
import { isHudWatcherCommand, ProcInspector, type HostProcess, type HostProcessInspector, type ProcessInspector } from '../discovery/processes.js';
import { TmuxAdapter } from '../tmux/adapter.js';

type DiscoverySnapshot = { refresh(force?: boolean): Promise<Agent[]> };
type CleanupAction = { target: CleanupTarget; socket?: SocketRef; paneId?: string; pid?: number };

const opaqueId = (kind: CleanupTargetKind, identity: string) => `cleanup-${createHash('sha256').update(`${kind}\0${identity}`).digest('base64url').slice(0, 24)}`;
const paneIdentity = (pane: Pane) => `${pane.socket.fingerprint}:${pane.paneId}`;
const paneLabel = (pane: Pane) => pane.displayLabel || pane.title || pane.sessionName || pane.paneId;

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
    const [codexFlags] = await Promise.all([
      Promise.all(panes.map(pane => this.processInspector.recognizeAgent(pane.pid)))
    ]);
    const codexPanes = new Set(panes.filter((_pane, index) => codexFlags[index] !== undefined).map(paneIdentity));
    const activeAgents = new Set(agents.map(agent => agent.id));
    const hudProcesses = processes.filter(process => isHudWatcherCommand(process.cmdline));
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
    const hudPaneIds = new Set(hudProcesses.map(process => paneAncestor(process.pid)).filter((pane): pane is Pane => pane !== undefined).map(paneIdentity));
    for (const pane of panes) if (/(?:^|[/\s])omx\s+hud(?:\s+[^\s]+)*\s+--watch(?:\s|$)/u.test(pane.startCommand ?? '')) hudPaneIds.add(paneIdentity(pane));
    const sessionHasLeader = new Set<string>();
    for (const pane of panes) {
      const identity = paneIdentity(pane);
      if (!isOmxWorkerPane(pane) && codexPanes.has(identity) && !hudPaneIds.has(identity)) sessionHasLeader.add(`${pane.socket.fingerprint}:${pane.sessionId}`);
    }

    const candidates: CleanupAction[] = [];
    for (const pane of panes) {
      const identity = paneIdentity(pane);
      const common = { socket: pane.socket, paneId: pane.paneId };
      if (hudPaneIds.has(identity)) {
        candidates.push({ ...common, target: this.target('hud-pane', `${identity}:${pane.pid}`, 'HUD watcher', `${paneLabel(pane)} in tmux session ${pane.sessionName ?? pane.sessionId}`) });
      } else if (isOmxWorkerPane(pane) && !sessionHasLeader.has(`${pane.socket.fingerprint}:${pane.sessionId}`)) {
        candidates.push({ ...common, target: this.target('orphan-worker', `${identity}:${pane.pid}`, 'Orphan OMX worker', `${paneLabel(pane)} in tmux session ${pane.sessionName ?? pane.sessionId}`) });
      } else if (codexPanes.has(identity) && !isOmxWorkerPane(pane) && !activeAgents.has(identity)) {
        candidates.push({ ...common, target: this.target('stale-agent', `${identity}:${pane.pid}`, 'Stale Codex agent', `${paneLabel(pane)} at ${pane.path}`) });
      }
    }

    const executorSocket = sockets[0];
    for (const process of hudProcesses) {
      if (paneAncestor(process.pid) !== undefined) continue;
      const identity = `${process.pid}:${process.startTime}`;
      candidates.push({
        target: this.target('hud-process', identity, 'Detached HUD watcher', `Host process ${process.pid}: ${process.cmdline.split('\0').filter(Boolean).join(' ')}`),
        ...(executorSocket === undefined ? {} : { socket: executorSocket }),
        pid: process.pid
      });
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
