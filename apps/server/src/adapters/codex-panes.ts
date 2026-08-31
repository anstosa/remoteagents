import type { Pane } from '../domain/models.js';
import type { HostProcess } from '../discovery/processes.js';
import type { CleanupClassification, PaneScan } from './types.js';

const node = /^(?:node|nodejs)(?:\.exe)?$/i;
// OMX spawns worker panes inside its team worktrees and from generated startup
// scripts. Both are excluded from the dashboard and are never a stale-agent.
const omxWorkerWorktree = /(?:^|\/)\.omx\/team\/[^/]+\/worktrees\/worker-\d+(?:\/|$)/u;
const omxWorkerStartup = /(?:^|\/)\.omx\/state\/team\/[^/]+\/runtime\/worker-\d+-startup\.sh(?:['"\s]|$)/u;
// A pane whose recorded start command launched the OMX HUD watcher.
const omxHudStartCommand = /(?:^|[/\s])omx\s+hud(?:\s+[^\s]+)*\s+--watch(?:\s|$)/u;

export function isOmxWorkerPane(pane: Pick<Pane, 'path' | 'startCommand'>): boolean {
  return omxWorkerWorktree.test(pane.path) || omxWorkerStartup.test(pane.startCommand ?? '');
}

// An `omx hud --watch` process, whether launched directly or through the Node shim.
export function isHudWatcherCommand(cmdline: string): boolean {
  const args = cmdline.split('\0').filter(Boolean);
  const executable = args[0]?.split('/').pop() ?? '';
  const omxIndex = /^(?:omx|omx\.js)$/iu.test(executable)
    ? 0
    : node.test(executable) ? args.findIndex((arg, index) => index > 0 && /^(?:omx|omx\.js)$/iu.test(arg.split('/').pop() ?? '')) : -1;
  return omxIndex >= 0 && args[omxIndex + 1] === 'hud' && args.slice(omxIndex + 2).includes('--watch');
}

const paneLabel = (pane: Pane) => pane.displayLabel || pane.title || pane.sessionName || pane.paneId;

// `classify` is called once per pane over a shared scan, so the two derived sets
// are memoised against the scan object rather than recomputed for every pane.
const hudCache = new WeakMap<PaneScan, Set<string>>();
const leaderCache = new WeakMap<PaneScan, Set<string>>();

// The panes running an OMX HUD watcher — either a watcher process lives in the
// pane's tree, or the pane's own start command is one. A HUD is a monitor, not
// an agent, so it is always a cleanup target.
function hudPaneIds(scan: PaneScan): Set<string> {
  const cached = hudCache.get(scan);
  if (cached !== undefined) return cached;
  const ids = new Set<string>();
  for (const process of scan.processes) {
    if (!isHudWatcherCommand(process.cmdline)) continue;
    const pane = scan.paneAncestor(process.pid);
    if (pane !== undefined) ids.add(scan.identity(pane));
  }
  for (const pane of scan.panes) if (omxHudStartCommand.test(pane.startCommand ?? '')) ids.add(scan.identity(pane));
  hudCache.set(scan, ids);
  return ids;
}

// A session has a leader when it still holds a live Codex pane that is neither an
// OMX worker nor the HUD watcher — the session a human is actually driving.
function sessionsWithLeader(scan: PaneScan): Set<string> {
  const cached = leaderCache.get(scan);
  if (cached !== undefined) return cached;
  const huds = hudPaneIds(scan);
  const leaders = new Set<string>();
  for (const pane of scan.panes) {
    if (scan.recognizedKind(pane) === 'codex' && !isOmxWorkerPane(pane) && !huds.has(scan.identity(pane))) leaders.add(scan.sessionIdentity(pane));
  }
  leaderCache.set(scan, leaders);
  return leaders;
}

export function classifyCodexPane(pane: Pane, scan: PaneScan): CleanupClassification | undefined {
  const session = pane.sessionName ?? pane.sessionId;
  if (hudPaneIds(scan).has(scan.identity(pane))) return { kind: 'hud-pane', label: 'HUD watcher', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (isOmxWorkerPane(pane) && !sessionsWithLeader(scan).has(scan.sessionIdentity(pane))) return { kind: 'orphan-worker', label: 'Orphan OMX worker', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (scan.recognizedKind(pane) === 'codex' && !isOmxWorkerPane(pane) && !scan.active(pane)) return { kind: 'stale-agent', label: 'Stale Codex agent', detail: `${paneLabel(pane)} at ${pane.path}` };
  return undefined;
}

export function classifyCodexProcess(process: HostProcess, scan: PaneScan): CleanupClassification | undefined {
  if (!isHudWatcherCommand(process.cmdline) || scan.paneAncestor(process.pid) !== undefined) return undefined;
  return { kind: 'hud-process', label: 'Detached HUD watcher', detail: `Host process ${process.pid}: ${process.cmdline.split('\0').filter(Boolean).join(' ')}` };
}
