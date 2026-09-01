/**
 * The Codex adapter's pure parsing and submission descriptions (ADR 0002).
 *
 * These functions turn a raw `capture-pane` snapshot into Codex's Turns and read
 * a prompt back out of one, and shape a prompt into the exact text Codex's
 * composer needs. They are dependency-free string transforms: the Codex Adapter
 * exposes them through `submission`/`turns`, and the console imports the handful
 * it still runs directly — the captured-window enrichment and the Codex-only
 * update-advisor flow. They used to live in the tmux and prompts modules; moving
 * them here is what makes Turn capture the Adapter's concern, not the console's.
 */

import type { SubmissionDraftState } from './types.js';

const selectedChoice = /^›\s+(?:\[[ xX]\]\s*)?\d+[.)]\s/u;
// identify Codex's bottom status row
const composerStatusLine = /^ {2}\S.*(?: · \S.*)+$/u;

/**
 * Tab is Codex's queue key.  Its completion menu owns Tab while the composer
 * ends in a token, though, so the prompt never reaches the queue.  A trailing
 * space dismisses that menu without changing the submitted prompt's meaning.
 */
export const queueReadyPrompt = (prompt: string) => /\s$/u.test(prompt) ? prompt : `${prompt} `;

// strip styling without adding semantic markup
const plainTerminalText = (value: string) => value
  .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\r/gu, '');

// read only the bottom-most live Codex composer, excluding matching scrollback
function activeComposerFromCapture(value: string): string | undefined {
  const lines = plainTerminalText(value).split('\n');
  let finalVisibleRow = lines.length - 1;
  // locate the terminal footer row above trailing space
  while (finalVisibleRow >= 0 && !lines[finalVisibleRow]!.trim()) finalVisibleRow -= 1;
  // inspect composer markers newest first
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^›(?:\s(.*))?$/u.exec(lines[index]!);
    // skip non-composer rows
    if (match === null) continue;
    const draft = [match[1] ?? ''];
    let submitted = false;
    // collect wrapped paragraphs and blank composer rows
    for (let following = index + 1; following < lines.length; following += 1) {
      const line = lines[following]!;
      // exclude terminal chrome from the draft
      if (following === finalVisibleRow && composerStatusLine.test(line)) break;
      // reject submitted prompt history followed by agent activity
      if (/^[•■─]/u.test(line)) {
        submitted = true;
        break;
      }
      draft.push(line.trim());
    }
    // inspect only a live composer
    if (submitted) continue;
    return draft.join(' ');
  }
  return undefined;
}

// classify whether one exact Codex draft is still live after a paste or keypress
export function codexDraftState(capture: string, prompt: string): SubmissionDraftState {
  const composer = activeComposerFromCapture(capture);
  // a transition without a structurally valid composer is inconclusive
  if (composer === undefined) return 'unknown';
  const normalizedComposer = composer.replace(/\s+/gu, ' ').trim();
  const normalizedPrompt = prompt.replace(/\s+/gu, ' ').trim();
  const visibleSuffix = normalizedPrompt.slice(-Math.min(64, normalizedPrompt.length));
  const collapsedPaste = `[Pasted Content ${prompt.length} chars]`;
  // accept Codex's exact long-paste placeholder
  if (normalizedComposer.includes(collapsedPaste)) return 'visible';
  // anchor short prompts at the composer start so footer text cannot match
  if (normalizedPrompt.length <= 64) return normalizedComposer.startsWith(normalizedPrompt) ? 'visible' : 'cleared';
  // match the visible tail when a long composer scrolls its prefix away
  return normalizedComposer.includes(visibleSuffix) ? 'visible' : 'cleared';
}

// a request failure or cancellation banner on the active (latest) turn
export function failedTurnFromCapture(capture: string): boolean {
  const latestPrompt = capture.lastIndexOf('\n› ');
  const latestTurn = latestPrompt < 0 ? capture : capture.slice(latestPrompt + 1);
  return /^■ (?:Request failed|Cancelled)\b/mu.test(latestTurn);
}

/**
 * `capture-pane -e` preserves the SGR codes tmux uses for its rendered
 * snapshot.  Keep those color/style codes, but discard every other terminal
 * control sequence: Codex can emit alternate-screen and OSC controls while a
 * completion menu is open, and replaying those in the browser xterm changes
 * its terminal state instead of just rendering the snapshot.
 */
export function lastPromptFromHistory(value: string): string | undefined {
  const lines = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/u.exec(lines[index]!);
    if (!match || selectedChoice.test(lines[index]!)) continue;
    const prompt = [match[1]];
    let continuation = index + 1;
    while (continuation < lines.length && /^ {2}\S/u.test(lines[continuation]!)) prompt.push(lines[continuation++]!.trim());
    while (continuation < lines.length && lines[continuation] === '') continuation += 1;
    if (/^•\s/u.test(lines[continuation] ?? '')) return prompt.join(' ');
  }
  return undefined;
}

const assistantMarkdown = (value: string) => {
  const withoutOsc = value.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '');
  const sgr = /\x1b\[([0-9;]*)m/gu;
  let markdown = '';
  let cursor = 0;
  let codeColor = false;
  let underlined = false;
  let codeOpen = false;
  const syncCode = () => {
    const next = codeColor && !underlined;
    if (next !== codeOpen) markdown += '`';
    codeOpen = next;
  };
  for (const match of withoutOsc.matchAll(sgr)) {
    markdown += withoutOsc.slice(cursor, match.index);
    const parameters = (match[1] || '0').split(';').map(Number);
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      if (parameter === 0) { codeColor = false; underlined = false; }
      else if (parameter === 4) underlined = true;
      else if (parameter === 24) underlined = false;
      else if (parameter === 39) codeColor = false;
      else if (parameter === 36) codeColor = true;
      else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) codeColor = false;
      else if (parameter === 38 && parameters[index + 1] === 5 && parameters[index + 2] !== undefined) {
        codeColor = parameters[index + 2] === 6;
        index += 2;
      } else if (parameter === 38 && parameters[index + 1] === 2 && parameters[index + 4] !== undefined) {
        codeColor = false;
        index += 4;
      }
    }
    syncCode();
    cursor = (match.index ?? 0) + match[0].length;
  }
  markdown += withoutOsc.slice(cursor);
  if (codeOpen) markdown += '`';
  return markdown.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '');
};

export type CompletedAssistantTurn = { prompt?: string; text: string; rows: number };

// find the prompt associated with one completion boundary
const promptBeforeCompletion = (lines: string[], completedAt: number): { index: number; text: string } | undefined => {
  // search backward for the nearest started prompt
  for (let index = completedAt - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/u.exec(lines[index]!);
    // skip non-prompt rows
    if (match === null || selectedChoice.test(lines[index]!)) continue;
    const prompt = [match[1]!];
    let following = index + 1;
    // collect wrapped prompt rows
    while (following < completedAt && /^ {2}\S/u.test(lines[following]!)) prompt.push(lines[following++]!.trim());
    // skip prompt spacing
    while (following < completedAt && lines[following] === '') following += 1;
    // require assistant activity for this prompt
    if (!/^•(?:\s|$)/u.test(lines[following] ?? '')) continue;
    return { index, text: prompt.join(' ') };
  }
  return undefined;
};

// detect output that makes an earlier boundary stale
const hasLaterAssistantActivity = (lines: string[], completedAt: number): boolean => {
  // inspect output after the candidate boundary
  for (let index = completedAt + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // ignore non-response status announcements
    if (/^• Model changed to\b/u.test(line)) continue;
    // reject any later assistant response activity
    if (/^•(?:\s|$)/u.test(line)) return true;
  }
  return false;
};

// capture the newest prompt-coherent completed turn
export function latestCompletedAssistantTurn(value: string): CompletedAssistantTurn | undefined {
  const lines = assistantMarkdown(value).split('\n');
  // inspect completion boundaries newest first
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timed = /^─ Worked for\b/u.test(lines[index]!);
    const untimed = /^─{3,}$/u.test(lines[index]!);
    // skip ordinary output rows
    if (!timed && !untimed) continue;
    // reject an intermediate divider or older completed turn
    if (hasLaterAssistantActivity(lines, index)) return undefined;
    const prompt = promptBeforeCompletion(lines, index);
    // require a prompt for ambiguous untimed dividers
    if (untimed && prompt === undefined) continue;
    const lowerBound = prompt?.index ?? -1;
    let start = index - 1;
    // find the final assistant message within this turn
    while (start > lowerBound && !/^•(?:\s|$)/u.test(lines[start]!)) start -= 1;
    // require final message content
    if (start <= lowerBound) continue;
    let contentEnd = index;
    // trim completion spacing
    while (contentEnd > start && !lines[contentEnd - 1]!.trim()) contentEnd -= 1;
    const rendered = lines.slice(start, contentEnd);
    rendered[0] = rendered[0]!.replace(/^•\s?/u, '');
    // remove terminal indentation
    for (let row = 1; row < rendered.length; row += 1) rendered[row] = rendered[row]!.replace(/^ {2}/u, '');
    const text = rendered.join('\n').trim();
    // return the first valid newest boundary
    if (text) return { ...(prompt === undefined ? {} : { prompt: prompt.text }), text, rows: contentEnd - start };
  }
  return undefined;
}

// expose only the completed response text
export function latestCompletedAssistantMessage(value: string): { text: string; rows: number } | undefined {
  const turn = latestCompletedAssistantTurn(value);
  return turn === undefined ? undefined : { text: turn.text, rows: turn.rows };
}

// capture the complete response after the latest prompt
export function latestAgentMessageFromHistory(value: string): string | undefined {
  const lines = plainTerminalText(value).split('\n');
  let promptAt = -1;
  // find the latest prompt boundary
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // ignore selected numbered choices
    if (/^›\s+\S/u.test(lines[index]!) && !selectedChoice.test(lines[index]!)) { promptAt = index; break; }
  }
  if (promptAt < 0) return undefined;
  let start = promptAt + 1;
  // skip wrapped prompt text
  while (start < lines.length && /^ {2}\S/u.test(lines[start]!)) start += 1;
  // skip prompt separation
  while (start < lines.length && !lines[start]!.trim()) start += 1;
  let end = lines.length;
  // trim unused terminal rows
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  const message = lines.slice(start, end).join('\n').trim();
  if (!message) return undefined;
  return message.length <= 64_000 ? message : message.slice(-64_000);
}
