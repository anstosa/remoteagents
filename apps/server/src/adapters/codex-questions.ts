import { inlineQuestionId } from './inline-questions.js';
import { normalizedLines } from './capture-text.js';
import type { InlineQuestion, TmuxKey } from './types.js';

// open only the live question footer with an explicitly supported advertised binding
export function queuedCodexQuestion(capture: string): { key?: TmuxKey } | undefined {
  const lines = normalizedLines(capture).filter(Boolean);
  const header = lines.lastIndexOf('• Queued follow-up inputs');
  // ignore ordinary queued messages and historical banners above newer output
  if (header < 0) return undefined;
  const footer = lines.slice(header + 1);
  // keep an opened question remembered when the operator returns to the main prompt
  const editorHint = footer.findIndex(line => /^enter submit(?:\s|$)/u.test(line));
  // navigation hints may wrap on a narrow terminal
  if (editorHint >= 0 && /^enter submit\s+ctrl \+ \] skip(?:\s+(?:alt|⌥|shift) \+ [↑↓←→] (?:main prompt|prev question|next question|queued messages))*$/u.test(footer.slice(editorHint).join(' '))) return {};
  const summary = footer.findIndex(line => /^\? [1-9]\d* questions?(?: · \d+s)?$/u.test(line));
  // require the collapsed summary directly followed by its answer shortcut
  if (summary < 0) return undefined;
  const hint = footer[summary + 1];
  const key = /^(?:alt|⌥) \+ ↑ to answer$/u.test(hint ?? '') ? 'M-Up'
    : /^shift \+ ← to answer$/u.test(hint ?? '') ? 'S-Left' : undefined;
  // reject a newer turn, open choice list, or modal below the queued footer
  if (key === undefined || footer.slice(summary + 2).some(line => !/^›(?: |$)/u.test(line)
    && !/^(?![•■])\S.* · \S/u.test(line) && !/^(?:\? for shortcuts(?:\s|$)|\d+% context left$)/u.test(line))) return undefined;
  return { key };
}

/**
 * The Codex inline-question logic, moved server-side (chunk 1 commit 5). An
 * Inline question reaches the console three ways: the agent draws a numbered
 * choice list on its pane (parsed here), OMX writes a structured question file
 * (`omx-questions.ts`, ADR 0005), or a Claude Agent reports one through its pane
 * (`claude-questions.ts`, ADR 0006). All are normalised to one {@link InlineQuestion}
 * with the same id rule (`inline-questions.ts`); the console renders it and
 * answers it through the Adapter's `selectOption`.
 */

// one numbered (or checkbox) choice row: leading selection caret, optional
// `[ ]`/`[x]` box, the displayed number, then the label
const questionChoiceLine = /^([›❯>]\s*)?(?:\[([ xX])\]\s*)?(\d+)[.)]\s+(.+)$/u;
// normalise one agent message into visible rows
const agentMessageLines = (message: string) => message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n').map(line => line.trim()).filter(Boolean);

/**
 * detect a numbered choice list the agent drew on its pane, adapted from
 * the web's `questionFromAgentMessage`: scan the latest output for a run of two
 * or more sequential numbered choices and the question that introduced them.
 * `choices` are the labels only; the console renders position + 1 as the number
 * and answers by position relative to the freshly captured selection caret.
 */
export function parseChoiceQuestion(message: string): InlineQuestion | undefined {
  const lines = agentMessageLines(message);
  let detected: { text: string; choices: string[]; selectedIndex?: number } | undefined;
  // inspect the latest output
  for (let start = Math.max(0, lines.length - 40); start < lines.length; start += 1) {
    const choices: string[] = [];
    let interactive = false;
    let selectedIndex: number | undefined;
    let caretCount = 0;
    let end = start;
    let expectedNumber: number | undefined;
    let wrappedLines = 0;
    // bridge wrapped descriptions
    while (end < lines.length && end - start < 32) {
      const match = questionChoiceLine.exec(lines[end]!);
      // retain sequential choices
      if (match) {
        const number = Number(match[3]);
        // reject invalid displayed numbers
        if (number < 1) break;
        // stop at another numbered block
        if (expectedNumber !== undefined && number !== expectedNumber) break;
        interactive ||= match[1] !== undefined || match[2] !== undefined;
        // track the keyboard cursor separately from checked or current values
        if (match[1] !== undefined) {
          selectedIndex = choices.length;
          caretCount += 1;
        }
        choices.push(match[4]!);
        expectedNumber = number + 1;
        wrappedLines = 0;
      } else {
        wrappedLines += 1;
        // bound continuation scanning
        if (choices.length === 0 || wrappedLines > 8 || /^(?:tab|enter|esc|[↑↓←→])/iu.test(lines[end]!)) break;
      }
      end += 1;
    }
    // require real choices
    if (choices.length < 2) continue;
    // quoted or malformed lists must not invent a unique keyboard cursor
    if (caretCount !== 1) selectedIndex = undefined;
    // skip starts inside this choice block
    const choiceEnd = end;
    const context = lines.slice(Math.max(0, start - 4), start).reverse();
    const question = interactive
      ? context.find(line => !/^question \d+ of \d+$/iu.test(line))
      : context.find(line => /[?]$|^(?:question|select|choose)\b/iu.test(line));
    // retain the latest question
    if (question) detected = { text: question.replace(/^[›❯>]\s*/u, ''), choices, ...(selectedIndex === undefined ? {} : { selectedIndex }) };
    start = Math.max(start, choiceEnd - 1);
  }
  return detected === undefined
    ? undefined
    : { ...detected, id: inlineQuestionId(detected.text, detected.choices), source: 'parsed' };
}
