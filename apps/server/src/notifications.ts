import type { Agent } from './domain/models.js';

export type AgentAttentionState = 'working' | 'question' | 'finished';
export type AgentNotification = {
  kind: 'question' | 'finished';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId?: string;
};
export type NotificationDismissal = { kind: 'dismiss'; tag: string; legacyTag: string; worktreeId?: string };
export type PushMessage = AgentNotification | NotificationDismissal;

type NotificationDelivery = (notification: AgentNotification) => void | Promise<void>;

const workingTitle = /^[\u2800-\u28ff]/u;
const actionRequiredTitle = /action required/iu;

export function agentAttentionState(agent: Agent): AgentAttentionState {
  if (agent.question !== undefined || actionRequiredTitle.test(agent.title)) return 'question';
  return workingTitle.test(agent.title) ? 'working' : 'finished';
}

export const agentNotificationTag = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent-status-${agent.id}` : `worktree-status-${agent.worktreeId}`;

export function agentNotification(previous: AgentAttentionState | undefined, current: AgentAttentionState, agent: Agent): AgentNotification | undefined {
  if (previous === undefined || previous === current) return undefined;
  const label = agent.worktreeLabel ?? agent.displayLabel ?? agent.title;
  const shared = { tag: agentNotificationTag(agent), url: `/#agent=${encodeURIComponent(agent.id)}`, ...(agent.worktreeId === undefined ? {} : { worktreeId: agent.worktreeId }) };
  if (current === 'question') {
    return {
      ...shared,
      kind: 'question',
      title: 'Agent has a question',
      body: agent.question === undefined ? `${label} is waiting for your response.` : `${label}: ${agent.question.text}`
    };
  }
  if (previous === 'working' && current === 'finished') {
    return { ...shared, kind: 'finished', title: 'Agent finished', body: `${label} is ready for another prompt.` };
  }
  return undefined;
}

export class AgentNotificationCoordinator {
  private readonly states = new Map<string, AgentAttentionState>();
  private readonly pendingCompletions = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deliver: NotificationDelivery, private readonly completionDelayMs = 2_000) {}

  observe(agent: Agent): void {
    const current = agentAttentionState(agent);
    const previous = this.states.get(agent.id);
    this.states.set(agent.id, current);

    if (current !== 'finished') this.cancelCompletion(agent.id);
    const notification = agentNotification(previous, current, agent);
    if (notification === undefined) return;
    if (notification.kind === 'question') {
      this.deliverSafely(notification);
      return;
    }

    this.cancelCompletion(agent.id);
    const timer = setTimeout(() => {
      this.pendingCompletions.delete(agent.id);
      if (this.states.get(agent.id) === 'finished') this.deliverSafely(notification);
    }, this.completionDelayMs);
    this.pendingCompletions.set(agent.id, timer);
  }

  retain(agentIds: Iterable<string>): void {
    const retained = new Set(agentIds);
    for (const agentId of this.states.keys()) {
      if (retained.has(agentId)) continue;
      this.cancelCompletion(agentId);
      this.states.delete(agentId);
    }
  }

  stop(): void {
    for (const timer of this.pendingCompletions.values()) clearTimeout(timer);
    this.pendingCompletions.clear();
  }

  private cancelCompletion(agentId: string): void {
    const timer = this.pendingCompletions.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingCompletions.delete(agentId);
  }

  private deliverSafely(notification: AgentNotification): void {
    void Promise.resolve(this.deliver(notification)).catch(() => {});
  }
}
