import { adapterFor } from './registry.js';
import type { AgentKind, AttentionState } from './types.js';

const attentionStates: ReadonlySet<string> = new Set<AttentionState>(['working', 'finished', 'question']);

// detect prose questions without mistaking code, links or quoted history for requests
export function messageAsksQuestion(message: string | undefined): boolean {
  // absent replies carry no question signal
  if (message === undefined) return false;
  let fence: string | undefined;
  const prose: string[] = [];
  // discard fenced code and quoted replies before inspecting punctuation
  for (const line of message.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    // retain the opening fence until its matching closing marker
    if (marker !== undefined) {
      // a different or shorter marker cannot close this code block
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    // quoted questions and indented code are not requests for input
    if (fence === undefined && !/^(?:\s*>| {4}|\t)/u.test(line)) prose.push(line);
  }
  const text = prose.join('\n')
    .replace(/(`+)[\s\S]*?\1/gu, '')
    .replace(/\[([^\]]*)\]\([^\s)]*(?:\s+"[^"]*")?\)/gu, '$1')
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gu, '');
  return /[?？؟](?=$|[\s*_~)\]"'’”])/u.test(text);
}

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
