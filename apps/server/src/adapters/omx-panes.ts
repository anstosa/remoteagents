import type { Pane } from '../domain/models.js';
import type { HostProcess } from '../discovery/processes.js';
import { isHudWatcherCommand } from './omx-processes.js';
import { paneLabel, type CleanupClassification, type PaneScan } from './types.js';

/**
 * The OMX Adapter's runtime-cleanup rules (ADR 0002, ADR 0005): the team worker
 * panes OMX spawns are hidden from the dashboard, a worker whose session lost its
 * leader is an orphan, a HUD watcher pane or process is a monitor to clean up,
 * and an OMX pane the dashboard no longer represents is a stale agent.
 */

// OMX spawns worker panes inside its team worktrees and from generated startup
// scripts. Both are excluded from the dashboard and are never a stale agent.
const omxWorkerWorktree = /(?:^|\/)\.omx\/team\/[^/]+\/worktrees\/worker-\d+(?:\/|$)/u;
const omxWorkerStartup = /(?:^|\/)\.omx\/state\/team\/[^/]+\/runtime\/worker-\d+-startup\.sh(?:['"\s]|$)/u;
// A pane whose recorded start command launched the OMX HUD watcher.
const omxHudStartCommand = /(?:^|[/\s])omx\s+hud(?:\s+[^\s]+)*\s+--watch(?:\s|$)/u;

export function isOmxWorkerPane(pane: Pick<Pane, 'path' | 'startCommand' | 'consoleManaged'>): boolean {
  // an explicit console launch owns the pane even inside a retained team checkout
  if (pane.consoleManaged === true) return false;
  return omxWorkerWorktree.test(pane.path) || omxWorkerStartup.test(pane.startCommand ?? '');
}

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

// A session has a leader when it still holds a live agent pane — OMX, or plain
// Codex, since a hand-started leader may be either — that no Adapter excludes and
// that is not the HUD watcher: the session a human is actually driving.
function sessionsWithLeader(scan: PaneScan): Set<string> {
  const cached = leaderCache.get(scan);
  if (cached !== undefined) return cached;
  const huds = hudPaneIds(scan);
  const leaders = new Set<string>();
  for (const pane of scan.panes) {
    const kind = scan.recognizedKind(pane);
    if ((kind === 'omx' || kind === 'codex') && !scan.excluded(pane) && !huds.has(scan.identity(pane))) leaders.add(scan.sessionIdentity(pane));
  }
  leaderCache.set(scan, leaders);
  return leaders;
}

export function classifyOmxPane(pane: Pane, scan: PaneScan): CleanupClassification | undefined {
  const session = pane.sessionName ?? pane.sessionId;
  if (hudPaneIds(scan).has(scan.identity(pane))) return { kind: 'hud-pane', label: 'HUD watcher', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (isOmxWorkerPane(pane) && !sessionsWithLeader(scan).has(scan.sessionIdentity(pane))) return { kind: 'orphan-worker', label: 'Orphan OMX worker', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (scan.recognizedKind(pane) === 'omx' && !scan.excluded(pane) && !scan.active(pane)) return { kind: 'stale-agent', label: 'Stale OMX agent', detail: `${paneLabel(pane)} at ${pane.path}` };
  return undefined;
}

export function classifyOmxProcess(process: HostProcess, scan: PaneScan): CleanupClassification | undefined {
  if (!isHudWatcherCommand(process.cmdline) || scan.paneAncestor(process.pid) !== undefined) return undefined;
  return { kind: 'hud-process', label: 'Detached HUD watcher', detail: `Host process ${process.pid}: ${process.cmdline.split('\0').filter(Boolean).join(' ')}` };
}
