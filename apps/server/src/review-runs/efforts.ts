// the agent kinds that can run a Review run (ADR 0010): one structured prompt, answered with JSON
export const reviewAgentKinds = ['codex', 'claude'] as const;
export type ReviewAgentKind = typeof reviewAgentKinds[number];

// the effort levels each kind accepts: Codex as `-c model_reasoning_effort=…`, Claude as `--effort`
export const reviewEfforts: Record<ReviewAgentKind, readonly string[]> = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max']
};

// narrow an arbitrary agent name to a Review run kind
export function isReviewAgentKind(value: string): value is ReviewAgentKind {
  return (reviewAgentKinds as readonly string[]).includes(value);
}

// whether one effort level is accepted by that kind's CLI
export function acceptsReviewEffort(kind: ReviewAgentKind, effort: string): boolean {
  return reviewEfforts[kind].includes(effort);
}
