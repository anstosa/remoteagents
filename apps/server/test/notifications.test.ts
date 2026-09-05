import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { resolveAttention } from '../src/adapters/attention.js';
import { AgentNotificationCoordinator, agentAttentionState, agentNotification, reviewNotification, type AgentNotification, type AgentNotificationContext } from '../src/notifications.js';

// Resolve attention from the title exactly as DiscoveryService would, so the
// coordinator reads the same resolved state the wire carries.
const agent = (overrides: Partial<Agent> = {}): Agent => {
  const title = overrides.title ?? 'Ready';
  return {
    id: 'socket:%1',
    paneId: '%1',
    sessionId: '$1',
    socketFingerprint: 'socket',
    workspace: '/workspace',
    title,
    kind: 'codex',
    attention: resolveAttention({ kind: 'codex', title, hasQuestion: overrides.question !== undefined }),
    worktreeId: 'eric',
    displayLabel: 'Eric',
    ...overrides
  };
};
const context: AgentNotificationContext = { projectName: 'Remote Agents', worktreeName: 'Eric', multipleWorktrees: true };

describe('agent notifications', () => {
  afterEach(() => vi.useRealTimers());

  it('distinguishes questions from completed work', () => {
    const questioning = agent({ title: '⠋ Working', question: { id: 'question-1', text: 'Deploy now?', choices: ['Yes', 'No'], source: 'structured', targetPaneId: '%2' } });

    expect(agentAttentionState(questioning)).toBe('question');
    expect(agentNotification('working', 'question', questioning, context)).toEqual({
      kind: 'question',
      title: 'Question in Remote Agents',
      body: 'Eric: Deploy now?',
      tag: 'worktree-status-eric',
      url: '/#agent=socket%3A%251',
      worktreeId: 'eric'
    });
    expect(agentNotification('working', 'finished', agent(), context)).toEqual({
      kind: 'finished',
      title: 'Done working in Remote Agents',
      body: 'Eric is ready for a new prompt',
      tag: 'worktree-status-eric',
      url: '/#agent=socket%3A%251',
      worktreeId: 'eric'
    });
  });

  it('does not misreport an action-required transition as completion', () => {
    const questioning = agent({ title: 'Action required | Approve command' });

    expect(agentAttentionState(questioning)).toBe('question');
    expect(agentNotification('working', 'question', questioning, context)?.body).toBe('Eric: has a question');
    expect(agentNotification('question', 'finished', agent())).toBeUndefined();
  });

  it('omits the worktree name from a single-worktree question', () => {
    const questioning = agent({ question: { id: 'question-1', text: 'Deploy now?', choices: ['Yes', 'No'], source: 'structured', targetPaneId: '%2' } });

    expect(agentNotification('working', 'question', questioning, { ...context, multipleWorktrees: false })?.body).toBe('Deploy now?');
  });

  it('builds a project-scoped guided review notification', () => {
    expect(reviewNotification('agent-1', 'eric', 'Remote Agents', 'Eric')).toEqual({
      kind: 'review',
      title: 'Review ready in Remote Agents',
      body: 'Eric is ready for review',
      tag: 'review-ready-eric',
      url: '/#agent=agent-1',
      worktreeId: 'eric'
    });
  });

  it('suppresses completion when another queued prompt starts during the grace period', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.observe(agent({ title: '⠙ Working' }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([]);
    coordinator.stop();
  });

  it('suppresses completion while a prompt remains queued', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }), true);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(delivered).toEqual([]);
    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  it('delivers completion after the agent remains finished', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('finished');
    expect(coordinator.isUnread(agent())).toBe(true);
    const replacement = agent({ id: 'socket:%2', paneId: '%2' });
    expect(coordinator.isUnread(replacement)).toBe(true);
    coordinator.view(replacement);
    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  it('clears the unread completion when a queued prompt starts', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.isUnread(agent())).toBe(true);

    coordinator.observe(agent({ title: '⠙ Working' }));

    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  it('does not mark a completion unread when it is viewed during the grace period', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    coordinator.view(agent());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(coordinator.isUnread(agent())).toBe(false);
    expect(delivered).toEqual([]);
    coordinator.stop();
  });

  it('cancels pending completion when the agent disappears', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    coordinator.retain([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([]);
    coordinator.stop();
  });
});
