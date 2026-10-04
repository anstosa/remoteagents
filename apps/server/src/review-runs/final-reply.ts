import { claudeLastAssistantText } from '../adapters/claude-conversations.js';
import { codexRolloutBaseline, codexTurnSince } from '../adapters/codex-conversations.js';
import type { CompletionBaseline } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';

// the discovered pane facts an interactive Review run's reply is read through (DiscoveryService)
export type ReplySources = {
  target(id: string, force?: boolean): Promise<{ agent: Agent } | undefined>;
  paneProcessId(id: string): number | undefined;
  paneWorkingDirectory(id: string): string | undefined;
  paneDirectory(id: string): string | undefined;
};

// Snapshot an interactive Review run's transcript before a prompt and return a reader for that
// turn's final message (ADR 0010), undefined until there is one. Codex: the turn's
// `task_complete.last_agent_message` past the pre-prompt rollout ordinal; a fresh thread opens its
// rollout only at its first turn, so it is then read from the start once the pane holds it.
// Claude: the last assistant message of the reported session's transcript, once it differs from
// the one before the prompt. `maxBytes` bounds the Codex answer (one past it, so an over-long
// reply still reads as too long).
export async function beginReplyTurn(sources: ReplySources, agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<() => Promise<string | undefined>> {
  if (agent.kind === 'claude') {
    // the session is pinned by one fresh pane read before the prompt; the reader's repeated reads
    // take the discovery snapshot the dashboard poll keeps current
    const read = async (fresh: boolean) => {
      const conversationId = (await sources.target(agent.id, fresh))?.agent.conversationId;
      return conversationId === undefined ? undefined : await claudeLastAssistantText(conversationId, sources.paneDirectory(agent.id));
    };
    const before = await read(true);
    return async () => { const text = await read(false); return text === before ? undefined : text; };
  }
  // the pane's rollout baseline: the exact fd-walk by pid, the unshared cwd as the fallback
  const baseline = async (): Promise<CompletionBaseline | undefined> => {
    const pid = sources.paneProcessId(agent.id);
    if (pid === undefined) return undefined;
    const cwd = sources.paneWorkingDirectory(agent.id);
    return await codexRolloutBaseline({ pid, ...(cwd === undefined ? {} : { cwd }) }).catch(() => undefined);
  };
  const before = await baseline();
  return async () => {
    const opened = before ?? await baseline();
    if (opened === undefined || !('rollout' in opened)) return undefined;
    const event = await codexTurnSince(before ?? { rollout: opened.rollout, ordinal: 0 }, maxBytes + 1).catch(() => undefined);
    return event?.kind === 'completed' ? event.answer : undefined;
  };
}
