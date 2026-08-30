import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { InlineQuestion } from './types.js';

/**
 * The Codex/OMX inline-question logic, moved server-side (chunk 1 commit 5). An
 * Inline question reaches the console two ways: OMX writes a structured question
 * file, or the agent draws a numbered choice list on its pane. Both are described
 * here and normalised to one {@link InlineQuestion}; the console renders it and
 * answers it through the Adapter's `selectOption`.
 */

// A stable id both transports agree on: the operator answers the question they
// saw, and a re-parse at answer time refuses a stale id. Text plus choices is
// the identity — the same NUL-joined hash the socket fingerprints use.
export function inlineQuestionId(text: string, choices: readonly string[]): string {
  return createHash('sha256').update([text, ...choices].join('\0')).digest('base64url').slice(0, 22);
}

// one numbered (or checkbox) choice row: leading selection caret, optional
// `[ ]`/`[x]` box, the displayed number, then the label
const questionChoiceLine = /^([›❯>]\s*)?(?:\[([ xX])\]\s*)?(\d+)[.)]\s+(.+)$/u;
// normalise one agent message into visible rows
const agentMessageLines = (message: string) => message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n').map(line => line.trim()).filter(Boolean);

/**
 * Detect a numbered choice list the agent drew on its pane. Ported verbatim from
 * the web's `questionFromAgentMessage`: scan the latest output for a run of two
 * or more sequential numbered choices and the question that introduced them.
 * `choices` are the labels only; the console renders position + 1 as the number
 * and answers by position, so a Codex menu is navigated by Down key count.
 */
export function parseChoiceQuestion(message: string): InlineQuestion | undefined {
  const lines = agentMessageLines(message);
  let detected: { text: string; choices: string[] } | undefined;
  // inspect the latest output
  for (let start = Math.max(0, lines.length - 40); start < lines.length; start += 1) {
    const choices: string[] = [];
    let interactive = false;
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
    // skip starts inside this choice block
    const choiceEnd = end;
    const context = lines.slice(Math.max(0, start - 4), start).reverse();
    const question = interactive
      ? context.find(line => !/^question \d+ of \d+$/iu.test(line))
      : context.find(line => /[?]$|^(?:question|select|choose)\b/iu.test(line));
    // retain the latest question
    if (question) detected = { text: question.replace(/^[›❯>]\s*/u, ''), choices };
    start = Math.max(start, choiceEnd - 1);
  }
  return detected === undefined
    ? undefined
    : { id: inlineQuestionId(detected.text, detected.choices), text: detected.text, choices: detected.choices, source: 'parsed' };
}

type OmxRecord = { kind?: unknown; question_id?: unknown; status?: unknown; question?: unknown; options?: unknown; questions?: unknown; renderer?: { target?: unknown; return_target?: unknown } };
const omxQuestionId = /^question-[A-Za-z0-9_.-]+$/u;
// read one OMX question file addressed at this pane into the unified shape
const readOmxQuestion = (raw: OmxRecord, paneId: string): InlineQuestion | undefined => {
  if (raw.kind !== 'omx.question/v1' || (raw.status !== 'pending' && raw.status !== 'prompting') || raw.renderer?.return_target !== paneId || typeof raw.renderer.target !== 'string' || !/^%\d+$/u.test(raw.renderer.target) || typeof raw.question_id !== 'string' || !omxQuestionId.test(raw.question_id)) return undefined;
  const first = Array.isArray(raw.questions) ? raw.questions[0] as { question?: unknown; options?: unknown } : undefined;
  const text = typeof first?.question === 'string' ? first.question : typeof raw.question === 'string' ? raw.question : undefined;
  const options = Array.isArray(first?.options) ? first.options : Array.isArray(raw.options) ? raw.options : [];
  const choices = options.map(option => option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string' ? (option as { label: string }).label : undefined).filter((value): value is string => value !== undefined);
  return text && choices.length >= 2 && choices.length <= 16
    ? { id: inlineQuestionId(text, choices), text, choices, source: 'structured', targetPaneId: raw.renderer.target }
    : undefined;
};

/**
 * The structured OMX question currently addressed at `paneId`, read from the
 * workspace's `.omx/state` question files. `targetPaneId` is OMX's renderer pane
 * — where the answer keys are sent, which is not always the agent's own pane.
 */
export async function pendingOmxQuestion(workspace: string, paneId: string): Promise<InlineQuestion | undefined> {
  const root = join(workspace, '.omx', 'state');
  const directories = [join(root, 'questions')];
  const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch(() => []);
  for (const session of sessions) if (session.isDirectory()) directories.push(join(root, 'sessions', session.name, 'questions'));
  for (const directory of directories) for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = await readFile(join(directory, entry.name), 'utf8').then(value => JSON.parse(value) as OmxRecord).catch(() => undefined);
    const question = parsed && readOmxQuestion(parsed, paneId); if (question) return question;
  }
  return undefined;
}
