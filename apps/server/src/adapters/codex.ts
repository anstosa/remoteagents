import { join } from 'node:path';
import { isAgentCommand } from '../discovery/processes.js';
import { codexDraftState, failedTurnFromCapture, lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from './codex-turns.js';
import { parseChoiceQuestion, pendingOmxQuestion } from './codex-questions.js';
import { codexConversationTitle, codexRolloutBaseline, codexTurnSince, discoverCodexConversation, validCodexThreadId } from './codex-conversations.js';
import type { Adapter, AttentionState, PromptCommand } from './types.js';

// Codex's curated slash commands, shown in the prompt box beside its `$skills`.
const codexSlash: PromptCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/skills', description: 'Browse available skills' },
  { name: '/status', description: 'Show the current session status' },
  { name: '/model', description: 'Choose a model' },
  { name: '/compact', description: 'Compact the conversation' },
  { name: '/new', description: 'Start a new conversation' },
  { name: '/resume', description: 'Resume a conversation' },
  { name: '/review', description: 'Review the current changes' },
  { name: '/diff', description: 'Show the current diff' },
  { name: '/init', description: 'Initialize project guidance' },
  { name: '/clear', description: 'Clear the conversation' },
  { name: '/quit', description: 'Exit the session' },
];

// Codex writes its Attention state into the pane title: a Braille spinner while
// working, an "action required" banner when it needs input, anything else once
// it has finished. This is the single home of that title rule (ADR 0001/0002).
const workingTitle = /^[\u2800-\u28ff]/u;
const actionRequiredTitle = /action required/iu;

function inferState(pane: { title: string }): AttentionState {
  if (actionRequiredTitle.test(pane.title)) return 'question';
  return workingTitle.test(pane.title) ? 'working' : 'finished';
}

/**
 * The Codex/OMX adapter — the first Adapter, extracted behind the interface with
 * zero behaviour change. `recognizes` and `inferState` are native; `submission`,
 * `turns` and `conversations` are thin facades over the functions that still
 * live in the prompts, tmux and bookmarks modules (chunks 4 and 7 relocate the
 * bodies here). One `codex` kind recognises both `codex` and `omx` processes.
 */
export const codexAdapter: Adapter = {
  kind: 'codex',
  stateSource: 'title',
  recognizes: ({ comm, argv }) => isAgentCommand(comm, argv.join('\0')),
  inferState,
  submission: {
    // codex submits idle prompts with Enter and queues active prompts with Tab
    // a trailing space dismisses the completion menu before either key
    prepare: (prompt, mode) => mode === 'shell'
      ? { text: prompt, keys: ['Enter'] }
      : { text: queueReadyPrompt(prompt), keys: ['Tab'], idleKeys: ['Enter'] },
    observeDraft: codexDraftState,
    interrupt: ['C-c'],
    selectOption: (index) => [...Array.from({ length: index }, () => 'Down' as const), 'Enter'],
  },
  turns: {
    latestCompleted: (capture) => latestCompletedAssistantTurn(capture),
    lastPrompt: (capture) => lastPromptFromHistory(capture),
    latestMessage: (capture) => latestAgentMessageFromHistory(capture),
    failed: failedTurnFromCapture,
  },
  questions: {
    // `capture` is either a raw pane capture or an already-isolated latest
    // message. Isolate the agent's latest message when a prompt boundary is
    // present (so the composer box below it never reads as a choice list); an
    // already-isolated message has none and is parsed as-is. Both paths yield
    // the same question — and so the same id — for a given on-screen list.
    parse: (capture) => parseChoiceQuestion(latestAgentMessageFromHistory(capture) ?? capture),
    pending: (workspace, paneId) => pendingOmxQuestion(workspace, paneId),
  },
  commands: {
    // The account-global skills override nothing; the workspace's `.codex/skills`
    // shadow same-named entries. Codex invokes a skill as `$name`.
    skillDirectories: (workspace, home) => [join(home, '.codex', 'skills'), join(workspace, '.codex', 'skills')],
    slash: codexSlash,
    skillInvocation: (name) => `$${name}`,
  },
  conversations: {
    validId: validCodexThreadId,
    discover: (pid) => discoverCodexConversation(pid),
    title: (id) => codexConversationTitle(id),
  },
  completion: {
    baseline: (pane) => codexRolloutBaseline(pane),
    since: (baseline) => codexTurnSince(baseline),
  },
};
