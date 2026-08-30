import { isAgentCommand } from '../discovery/processes.js';
import { failedTurnFromCapture, lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from './codex-turns.js';
import { validCodexThreadId } from '../bookmarks/service.js';
import type { Adapter, AttentionState } from './types.js';

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
    // Codex queues a normal prompt with Tab after a trailing space (which
    // dismisses its completion menu); its `!` shell mode submits with Enter.
    prepare: (prompt, mode) => mode === 'shell'
      ? { text: prompt, keys: ['Enter'] }
      : { text: queueReadyPrompt(prompt), keys: ['Tab'] },
    interrupt: ['C-c'],
    selectOption: (index) => [...Array.from({ length: index }, () => 'Down' as const), 'Enter'],
  },
  turns: {
    latestCompleted: (capture) => latestCompletedAssistantTurn(capture),
    lastPrompt: (capture) => lastPromptFromHistory(capture),
    latestMessage: (capture) => latestAgentMessageFromHistory(capture),
    failed: failedTurnFromCapture,
  },
  conversations: { validId: validCodexThreadId },
};
