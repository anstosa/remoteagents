import type { Agent, Worktree } from '../domain/models.js';
import type { DiscoveryService } from '../discovery/service.js';

export type ResolvedWorkspace = { agent: Agent; worktree: Worktree; workspace: string };

// the association rule: an Agent belongs to the Worktree whose git toplevel its pane
// reports, matched exactly — the console path (`identity`), or the host path (`hostPath`)
// under the bridge — never a prefix. the bridge host-path fallback lives only here
export function worktreeMatchesWorkspace(worktree: Pick<Worktree, 'identity' | 'hostPath'>, workspace: string): boolean {
  return workspace === worktree.identity || workspace === worktree.hostPath;
}

// the Worktree wire id `<projectId>:<realpath>` (ADR 0003) — the single derivation
// discovery and the Add flow share, so a hand-built id can never drift from discovery's
export function worktreeWireId(projectId: string, realpath: string): string {
  return `${projectId}:${realpath}`;
}

// the Project id embedded in a Worktree wire id `<projectId>:<realpath>` (ADR 0003); a
// key with no `:` (a bare `<projectId>` or the `scratch` group) is returned unchanged
export function projectIdOf(worktreeKey: string): string {
  const colon = worktreeKey.indexOf(':');
  return colon === -1 ? worktreeKey : worktreeKey.slice(0, colon);
}

// the realpath embedded in a Worktree wire id `<projectId>:<realpath>` (ADR 0003), or
// undefined for a key with no `:` (a bare `<projectId>` scope or the `scratch` group). The
// counterpart to `projectIdOf`, so the wire-id format stays owned by this module.
export function worktreePathOf(worktreeKey: string): string | undefined {
  const colon = worktreeKey.indexOf(':');
  return colon === -1 ? undefined : worktreeKey.slice(colon + 1);
}

// one discovered Worktree by its wire id `<projectId>:<realpath>` — the single by-id
// resolver every service shares over the current `discovery.worktreesNow()` snapshot
export function worktreeById(worktrees: readonly Worktree[], id: string): Worktree | undefined {
  return worktrees.find(worktree => worktree.id === id);
}

// the worktree root as the launching/command host sees it: the bridge host path when
// the worktree is mounted from the host, else the console's own git toplevel
export function worktreeHostRoot(worktree: Pick<Worktree, 'identity' | 'hostPath'>): string {
  return worktree.hostPath ?? worktree.identity;
}

// resolve one unambiguous configured workspace
export function configuredWorktreeForWorkspace(worktrees: Worktree[], workspace: string): Worktree | undefined {
  const matches = worktrees.filter(candidate => worktreeMatchesWorkspace(candidate, workspace));
  return matches.length === 1 ? matches[0] : undefined;
}

// resolve the discovered Worktree an Agent belongs to, enriched with dashboard comparison
// metadata. Worktrees come from discovery, which owns `git worktree list` (ADR 0003).
export async function resolveConfiguredWorkspace(discovery: DiscoveryService, agentId: string): Promise<ResolvedWorkspace | undefined> {
  const target = await discovery.target(agentId);
  // require a current agent target
  if (target === undefined) return undefined;
  const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.workspace);
  // exclude scratch agents
  if (worktree === undefined) return undefined;
  const dashboard = await discovery.dashboard();
  const enriched = dashboard.agents.find(candidate => candidate.id === target.agent.id && candidate.worktreeId === worktree.id);
  // retain comparison metadata from dashboard enrichment
  return { agent: enriched ?? target.agent, worktree, workspace: worktree.identity };
}

// revalidate agent identity before publishing
export async function sameConfiguredWorkspace(discovery: DiscoveryService, agentId: string, expected: ResolvedWorkspace): Promise<boolean> {
  const current = await resolveConfiguredWorkspace(discovery, agentId);
  // reject replacement agents and path drift
  return current !== undefined && current.agent.id === expected.agent.id && current.worktree.id === expected.worktree.id && current.workspace === expected.workspace;
}
