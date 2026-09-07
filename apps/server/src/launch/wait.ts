import type { Agent, Dashboard } from '../domain/models.js';

// A launched agent can take up to a minute to appear on the dashboard, so every
// launch route (and the Run primitive) polls discovery for that long before giving up.
export const launchReadyTimeoutSeconds = 60;
export const launchPollIntervalMs = 250;
export const launchPollAttempts = launchReadyTimeoutSeconds * 1_000 / launchPollIntervalMs;

/**
 * The real inter-poll delay; tests inject a no-op to skip the wall-clock wait.
 */
export const launchPollDelay = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, launchPollIntervalMs));

/**
 * Poll discovery for a freshly launched agent — one whose id is not in `before`,
 * optionally narrowed to a Worktree or a display label — for up to sixty seconds.
 * Extracted from `buildApp` so the launch routes and the Run primitive share one
 * poll (Scheduled prompts). `pollDelay` is the injectable inter-attempt wait.
 */
export type AgentWaiter = (before: Set<string>, worktreeId?: string, displayLabel?: string) => Promise<Agent | undefined>;

export function createAgentWaiter(discovery: { dashboard(force?: boolean): Promise<Dashboard> }, pollDelay: () => Promise<void>): AgentWaiter {
  return async (before, worktreeId, displayLabel) => {
    // poll for up to sixty seconds
    for (let attempt = 0; attempt < launchPollAttempts; attempt += 1) {
      const dashboard = await discovery.dashboard();
      const agent = dashboard.agents.find(candidate => !before.has(candidate.id)
        && (worktreeId === undefined || candidate.worktreeId === worktreeId)
        && (displayLabel === undefined || candidate.displayLabel === displayLabel));
      // return the ready agent
      if (agent) return agent;
      // pause before retrying
      if (attempt + 1 < launchPollAttempts) await pollDelay();
    }
    return undefined;
  };
}
