/**
 * A thin shim that presents today's Codex/OMX functions as an Adapter, so the
 * contract suite can run green against the current code before any of it moves
 * (chunk 1 commit 1, fixtures-first). Every substantive parser is imported from
 * `src` so the fixtures lock the *real* behaviour; only the two pieces that are
 * not yet standalone exports — the shell-mode/key decision embedded in
 * `PromptService.send`, and the private `failedTurnFromCapture` — are reproduced
 * here verbatim. Commit 4 extracts those into `adapter.submission`/`adapter.turns`
 * and this shim is replaced by the real Codex adapter.
 */

import { isAgentCommand } from '../../src/discovery/processes.js';
import { agentAttentionState } from '../../src/notifications.js';
import { queueReadyPrompt } from '../../src/prompts/service.js';
import { lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantTurn } from '../../src/tmux/adapter.js';
import { validCodexThreadId } from '../../src/bookmarks/service.js';
import type { Agent } from '../../src/domain/models.js';
import type { AdapterContract } from './contract.js';

// Reproduces PromptService.failedTurnFromCapture (private today): a request
// failure or cancellation banner on the active (latest) turn.
const failedTurnFromCapture = (capture: string): boolean => {
  const latestPrompt = capture.lastIndexOf('\n› ');
  const latestTurn = latestPrompt < 0 ? capture : capture.slice(latestPrompt + 1);
  return /^■ (?:Request failed|Cancelled)\b/mu.test(latestTurn);
};

export const codexShim: AdapterContract = {
  kind: 'codex',
  stateSource: 'title',
  recognizes: ({ comm, argv }) => isAgentCommand(comm, argv.join('\0')),
  inferState: (pane) => agentAttentionState({ title: pane.title } as unknown as Agent),
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
