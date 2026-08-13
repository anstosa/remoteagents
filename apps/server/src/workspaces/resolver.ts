import type { Agent, Worktree } from '../domain/models.js';
import type { DiscoveryService } from '../discovery/service.js';

export type ResolvedWorkspace = { agent: Agent; worktree: Worktree; workspace: string };

// resolve one unambiguous configured workspace
export function configuredWorktreeForWorkspace(worktrees: Worktree[], workspace: string): Worktree | undefined {
  const matches = worktrees.filter(candidate => workspace === candidate.identity || workspace === candidate.hostPath);
  return matches.length === 1 ? matches[0] : undefined;
}

// resolve configured worktree authority
export async function resolveConfiguredWorkspace(discovery: DiscoveryService, worktrees: Worktree[], agentId: string): Promise<ResolvedWorkspace | undefined> {
  const target = await discovery.target(agentId);
  // require a current agent target
  if (target === undefined) return undefined;
  const worktree = configuredWorktreeForWorkspace(worktrees, target.agent.workspace);
  // exclude scratch agents
  if (worktree === undefined) return undefined;
  const dashboard = await discovery.dashboard(worktrees);
  const enriched = dashboard.agents.find(candidate => candidate.id === target.agent.id && candidate.worktreeId === worktree.id);
  // retain comparison metadata from dashboard enrichment
  return { agent: enriched ?? target.agent, worktree, workspace: worktree.identity };
}

// revalidate agent identity before publishing
export async function sameConfiguredWorkspace(discovery: DiscoveryService, worktrees: Worktree[], agentId: string, expected: ResolvedWorkspace): Promise<boolean> {
  const current = await resolveConfiguredWorkspace(discovery, worktrees, agentId);
  // reject replacement agents and path drift
  return current !== undefined && current.agent.id === expected.agent.id && current.worktree.id === expected.worktree.id && current.workspace === expected.workspace;
}
