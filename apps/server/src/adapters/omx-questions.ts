import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion } from './types.js';

/**
 * OMX's structured Inline questions (ADR 0005). Besides the numbered choice list
 * the Codex TUI can draw (parsed in `codex-questions.ts`), OMX writes a question
 * file under the workspace's `.omx/state` addressed at a pane; it is normalised to
 * the same {@link InlineQuestion} — and the same id — so the console renders and
 * answers both transports alike through the Adapter's `selectOption`.
 */

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
