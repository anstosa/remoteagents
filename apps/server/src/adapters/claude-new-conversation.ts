import { normalizedCapture, normalizedLines } from './capture-text.js';
import type { Adapter, LaunchReadiness, PaneSnapshot, ResetSettling } from './types.js';

// A merged `/clear` (a lost paste) never changes the reported id; the probe saw the
// change land in ~100 ms, so two seconds without one means the command was swallowed.
const resetBudgetMs = 2000;

/**
 * How a Run resets a Claude pane to a fresh conversation and knows a fresh launch is
 * ready (Scheduled prompts; probe `docs/research/new-conversation-settle-probe.md`).
 * Pure functions over captures and pane snapshots; the console pastes and polls.
 */

// The composer is the last input row (`❯ …`); it is empty only when nothing follows
// the caret. A draft leaves its text there, and an open dialog draws its highlighted
// option as the last caret row (`❯ 1. …`), so both read as non-empty through this
// one rule. Box borders and ANSI are already gone, so an empty composer is `❯` alone.
function composerEmpty(capture: string): boolean {
  const rows = normalizedLines(capture).filter(line => line.startsWith('❯'));
  return rows.at(-1) === '❯';
}

/**
 * `/clear` fires a SessionEnd/SessionStart pair with a new reported id in ~100 ms; a
 * command merged into the composer (a lost paste) never changes it. So the reset has
 * taken once a snapshot reports an id different from the one before the command, and
 * is lost if none does within two seconds. The change is trusted only when `before`
 * captured an id to compare against: without one, a reported id could be the
 * pre-existing conversation `before` simply had not read yet, which is not a reset.
 */
function settled(before: PaneSnapshot, observed: readonly PaneSnapshot[], elapsedMs: number): ResetSettling {
  const changed = before.conversationId !== undefined
    && observed.some(snapshot => snapshot.conversationId !== undefined && snapshot.conversationId !== before.conversationId);
  if (changed) return 'settled';
  return elapsedMs >= resetBudgetMs ? 'lost' : 'pending';
}

// The untrusted-directory dialog: "Quick safety check: Is this a project you … trust?"
// with "No, exit" highlighted. No hook fires while it is up, so no id is ever reported.
const safetyCheck = /Quick safety check/i;

/**
 * A fresh Claude launch reports its session id (`SessionStart` source `startup`) at
 * about two seconds; until then no prompt should be pasted. An untrusted directory
 * blocks on the safety-check dialog instead, which never reports an id.
 */
function ready(snapshot: PaneSnapshot, capture: string): LaunchReadiness {
  if (safetyCheck.test(normalizedCapture(capture))) return { state: 'blocked', reason: 'untrusted directory: safety check' };
  return snapshot.conversationId === undefined ? { state: 'pending' } : { state: 'ready' };
}

export const claudeNewConversation: NonNullable<Adapter['newConversation']> = {
  command: '/clear',
  composerEmpty,
  settled,
  ready,
};
