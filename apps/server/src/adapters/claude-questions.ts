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
 *
 * A call carrying several questions walks one tab at a time: only the active tab's
 * text and rows are drawn, so exactly one of the payload's questions is live at a
 * time. After the last answer a review page repeats every question's text with its
 * answer and offers Submit answers / Cancel; that page is matched by its own literal
 * before any question text, and rendered as the two-choice question `selectOption(0)`
 * submits.
 */

// only the bottom of the screen holds the live dialog; the transcript above repeats
// answered and declined question text, so scrollback must not count
const questionWindowLines = 80;

// a single-choice question ready to render: its text and its option labels. The
// review/submit step of a multi-question call is one more of these — its prompt as
// the text, Submit answers / Cancel as the choices — so it matches through the same
// `isLive` check and renders through the same `asInline`.
type Renderable = { text: string; choices: string[] };
const reviewStep: Renderable = { text: 'Ready to submit your answers?', choices: ['Submit answers', 'Cancel'] };

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
function renderableQuestion(question: ReportedQuestion): Renderable | undefined {
  if (question.multiSelect === true || !isNonEmptyString(question.question) || !Array.isArray(question.options)) return undefined;
  const choices = question.options.map(option => (option as ReportedOption)?.label).filter(isNonEmptyString);
  // every option must carry a label, and the list must be a real choice set
  if (choices.length !== question.options.length || choices.length < 2 || choices.length > 16) return undefined;
  return { text: question.question, choices };
}

const asInline = ({ text, choices }: Renderable): InlineQuestion =>
  ({ id: inlineQuestionId(text, choices), text, choices: [...choices], source: 'structured' });

// the normalised last-80-line window. Claude pads blank rows below the dialog to
// the pane height, so trailing blanks are trimmed before windowing — otherwise a
// tall pane with a short session would push the dialog's top (its question text)
// above the last 80 lines
function captureWindow(capture: string): string {
  const lines = capture.split('\n');
  while (lines.length > 0 && normalize(lines[lines.length - 1]!) === '') lines.pop();
  return normalize(lines.slice(-questionWindowLines).join('\n'));
}

// a question is live only when its text (or its 48-char prefix, for a truncating
// narrow pane) and its first numbered option row are both on screen; the
// answered/declined summaries repeat the text but never draw a numbered row
function isLive({ text, choices }: Renderable, window: string): boolean {
  const normalizedText = normalize(text);
  const textPresent = window.includes(normalizedText) || window.includes(normalizedText.slice(0, 48));
  return textPresent && window.includes(normalize(`1. ${choices[0]}`));
}

/**
 * The Inline question a Claude Agent reported through its pane, confirmed live on
 * the capture. `payload` is the base64 PreToolUse hook body from `@rac_question`;
 * `capture` is a raw `capture-pane -e -p` snapshot. Pure and side-effect-free.
 */
export function reportedClaudeQuestion(payload: string, capture: string): InlineQuestion | undefined {
  const questions = decodeQuestions(payload);
  if (questions === undefined) return undefined;
  const window = captureWindow(capture);
  // A multi-question call ends on a review page that repeats every question's text,
  // so the submit step is matched by its own prompt before any question text; its
  // Submit answers row is drawn first, so selectOption(0) submits.
  if (questions.length >= 2 && isLive(reviewStep, window)) return asInline(reviewStep);
  // Otherwise the one question on screen. Only the active tab is drawn, so exactly
  // one renderable question is live; zero (answered/cancelled) or several
  // (indistinguishable identical text and first option) render nothing.
  const live = questions
    .map(renderableQuestion)
    .filter((question): question is Renderable => question !== undefined && isLive(question, window));
  return live.length === 1 ? asInline(live[0]!) : undefined;
}
