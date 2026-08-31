import { adapterFor } from './registry.js';
import type { AgentKind, AttentionState } from './types.js';

const attentionStates: ReadonlySet<string> = new Set<AttentionState>(['working', 'finished', 'question']);

/** A `@rac_attention` pane option is honoured only when it is a known state word. */
export function parseReportedAttention(value: string | undefined): AttentionState | undefined {
  return value !== undefined && attentionStates.has(value) ? value as AttentionState : undefined;
}

/**
 * The single home of Attention precedence (ADR 0001/0002): a reported state that
 * the agent wrote on its own pane (valid only while that process lives, which
 * the caller guarantees) wins; then a pending Inline question; then the
 * Adapter's title-derived Inferred state; then `finished`.
 */
export function resolveAttention(input: {
  kind: AgentKind;
  title: string;
  reported?: AttentionState;
  hasQuestion: boolean;
}): AttentionState {
  if (input.reported !== undefined) return input.reported;
  if (input.hasQuestion) return 'question';
  return adapterFor(input.kind)?.inferState({ title: input.title }) ?? 'finished';
}
