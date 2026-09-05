import type { Agent } from './domain/models.js';
import type { AttentionState } from './adapters/types.js';

export type AgentAttentionState = AttentionState;
export type AgentNotificationContext = {
  projectName: string;
  worktreeName: string;
  multipleWorktrees: boolean;
};
export type AgentNotification = {
  kind: 'question' | 'finished';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId?: string;
};
export type CleanupNotification = {
  kind: 'cleanup';
  title: string;
  body: string;
  tag: 'runtime-cleanup';
  url: '/#cleanup';
};
export type ReviewNotification = {
  kind: 'review';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId: string;
};
export type PushMessage = AgentNotification | CleanupNotification | ReviewNotification;

type NotificationDelivery = (notification: AgentNotification) => void | Promise<void>;

const attentionKey = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent:${agent.id}` : `worktree:${agent.worktreeId}`;

// Attention is resolved once, server-side, in DiscoveryService (ADR 0001/0002);
// every consumer, including this coordinator, reads that resolved state.
export function agentAttentionState(agent: Pick<Agent, 'attention'>): AgentAttentionState {
  return agent.attention;
}

export const agentNotificationTag = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent-status-${agent.id}` : `worktree-status-${agent.worktreeId}`;

// build one review-ready push payload
export function reviewNotification(agentId: string, worktreeId: string, projectName: string, worktreeName: string): ReviewNotification {
  return { kind: 'review', title: `Review ready in ${projectName}`, body: `${worktreeName} is ready for review`, tag: `review-ready-${worktreeId}`, url: `/#agent=${encodeURIComponent(agentId)}`, worktreeId };
}

// build one agent-state push payload
export function agentNotification(previous: AgentAttentionState | undefined, current: AgentAttentionState, agent: Agent, context?: AgentNotificationContext): AgentNotification | undefined {
  if (previous === undefined || previous === current) return undefined;
  const fallbackName = agent.displayLabel ?? agent.workspace.split('/').filter(Boolean).at(-1) ?? agent.title;
  const projectName = context?.projectName ?? fallbackName;
  const worktreeName = context?.worktreeName ?? fallbackName;
  const shared = { tag: agentNotificationTag(agent), url: `/#agent=${encodeURIComponent(agent.id)}`, ...(agent.worktreeId === undefined ? {} : { worktreeId: agent.worktreeId }) };
  if (current === 'question') {
    const body = agent.question === undefined
      ? `${worktreeName}: has a question`
      : `${context?.multipleWorktrees === true ? `${worktreeName}: ` : ''}${agent.question.text}`;
    return {
      ...shared,
      kind: 'question',
      title: `Question in ${projectName}`,
      body
    };
  }
  if (previous === 'working' && current === 'finished') {
    return { ...shared, kind: 'finished', title: `Done working in ${projectName}`, body: `${worktreeName} is ready for a new prompt` };
  }
  return undefined;
}

export class AgentNotificationCoordinator {
  private readonly states = new Map<string, AgentAttentionState>();
  private readonly pendingCompletions = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unread = new Set<string>();

  constructor(private readonly deliver: NotificationDelivery, private readonly completionDelayMs = 2_000) {}

  observe(agent: Agent, hasQueuedPrompt = false, context?: AgentNotificationContext): void {
    const key = attentionKey(agent);
    const current = agentAttentionState(agent);
    const previous = this.states.get(key);
    this.states.set(key, current);

    // suppress intermediate queue completions
    if (current === 'finished' && hasQueuedPrompt) {
      this.cancelCompletion(key);
      this.unread.delete(key);
      return;
    }
    if (current !== 'finished') {
      this.cancelCompletion(key);
      this.unread.delete(key);
    }
    const notification = agentNotification(previous, current, agent, context);
    if (notification === undefined) return;
    if (notification.kind === 'question') {
      this.deliverSafely(notification);
      return;
    }

    this.cancelCompletion(key);
    const timer = setTimeout(() => {
      this.pendingCompletions.delete(key);
      if (this.states.get(key) !== 'finished') return;
      this.unread.add(key);
      this.deliverSafely(notification);
    }, this.completionDelayMs);
    this.pendingCompletions.set(key, timer);
  }

  isUnread(agent: Pick<Agent, 'id' | 'worktreeId'>): boolean {
    return this.unread.has(attentionKey(agent));
  }

  view(agent: Pick<Agent, 'id' | 'worktreeId'>): void {
    const key = attentionKey(agent);
    this.unread.delete(key);
    this.cancelCompletion(key);
  }

  retain(agents: Iterable<Pick<Agent, 'id' | 'worktreeId'>>): void {
    const retained = new Set(Array.from(agents, attentionKey));
    for (const key of this.states.keys()) {
      if (retained.has(key)) continue;
      this.cancelCompletion(key);
      this.states.delete(key);
      this.unread.delete(key);
    }
  }

  stop(): void {
    for (const timer of this.pendingCompletions.values()) clearTimeout(timer);
    this.pendingCompletions.clear();
    this.unread.clear();
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
