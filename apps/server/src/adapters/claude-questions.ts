import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion } from './types.js';

/**
 * Claude Code's `AskUserQuestion` dialog rendered as an Inline question (ADR 0006).
 * The console never parses the TUI: the question's content arrives exact through the
 * hook payload the Agent reports on its pane (`@rac_question`), and two presence
 * checks on the pane's capture — both built from the payload's own strings — decide
 * whether the dialog is still open. An Esc cancel fires no hook, and the transcript
 * repeats every answered or declined question's text, so a question counts as live
 * only when its text *and* its first numbered option row are on screen.
 */

// only the bottom of the screen holds the live dialog; the transcript above repeats
// answered and declined question text, so scrollback must not count
const questionWindowLines = 80;

type ReportedOption = { label?: unknown };
type ReportedQuestion = { question?: unknown; options?: unknown; multiSelect?: unknown };
type ReportedPayload = { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { questions?: unknown } };

// normalise pane text and payload strings the same way: drop ANSI, turn box-drawing
// and bar glyphs into spaces (a wrapped question is drawn under a `│ ` prefix), then
// collapse all whitespace so a wrapped line or a caret-prefixed row matches its string
function normalize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')  // OSC (e.g. hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')            // CSI (colours, cursor)
    .replace(/[─-╿|]/gu, ' ')                  // box-drawing and the ascii bar
    .replace(/\s+/gu, ' ')
    .trim();
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// the questions array of a well-formed PreToolUse AskUserQuestion body, or undefined
function decodeQuestions(payload: string): ReportedQuestion[] | undefined {
  let parsed: ReportedPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as ReportedPayload;
  } catch { return undefined; }
  if (parsed?.hook_event_name !== 'PreToolUse' || parsed.tool_name !== 'AskUserQuestion') return undefined;
  const questions = parsed.tool_input?.questions;
  // agent-controlled content: validate the shape defensively
  return Array.isArray(questions) && questions.length >= 1 && questions.length <= 4 ? questions as ReportedQuestion[] : undefined;
}

// one single-choice question with 2–16 labelled options, or undefined (multiSelect,
// option-less text/number kinds, and malformed option lists render nothing in v1)
function renderableQuestion(question: ReportedQuestion): { text: string; choices: string[] } | undefined {
  if (question.multiSelect === true || !isNonEmptyString(question.question) || !Array.isArray(question.options)) return undefined;
  const choices = question.options.map(option => (option as ReportedOption)?.label).filter(isNonEmptyString);
  // every option must carry a label, and the list must be a real choice set
  if (choices.length !== question.options.length || choices.length < 2 || choices.length > 16) return undefined;
  return { text: question.question, choices };
}

/**
 * The Inline question a Claude Agent reported through its pane, confirmed live on
 * the capture. `payload` is the base64 PreToolUse hook body from `@rac_question`;
 * `capture` is a raw `capture-pane -e -p` snapshot. Pure and side-effect-free.
 */
export function reportedClaudeQuestion(payload: string, capture: string): InlineQuestion | undefined {
  const questions = decodeQuestions(payload);
  // the multi-question match and its review/submit step are a later slice; a call
  // carrying several questions renders nothing here (the operator answers in the pane)
  if (questions === undefined || questions.length !== 1) return undefined;
  const question = renderableQuestion(questions[0]!);
  if (question === undefined) return undefined;
  // Claude pads blank rows below the dialog to the pane height; drop them before
  // windowing so a tall pane with a short session keeps the dialog's top (its
  // question text) inside the last 80 lines, not above them
  const lines = capture.split('\n');
  while (lines.length > 0 && normalize(lines[lines.length - 1]!) === '') lines.pop();
  const window = normalize(lines.slice(-questionWindowLines).join('\n'));
  const text = normalize(question.text);
  // live only when the question text (or its 48-char prefix, for a truncating narrow
  // pane) and the first numbered option row are both on screen; the answered/declined
  // summaries repeat the text but never draw a numbered row
  const textPresent = window.includes(text) || window.includes(text.slice(0, 48));
  const rowPresent = window.includes(normalize(`1. ${question.choices[0]}`));
  return textPresent && rowPresent
    ? { id: inlineQuestionId(question.text, question.choices), text: question.text, choices: question.choices, source: 'structured' }
    : undefined;
}
