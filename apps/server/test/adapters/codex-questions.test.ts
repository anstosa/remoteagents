import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineQuestionId, pendingOmxQuestion } from '../../src/adapters/codex-questions.js';

describe('inlineQuestionId', () => {
  it('is a stable 22-char base64url hash of the text and choices', () => {
    // pinned so a constant-id regression (e.g. returning a fixed string) fails here
    expect(inlineQuestionId('a', ['b', 'c'])).toBe('i63eEMdg6bcC3vtLXiJd55');
    expect(inlineQuestionId('a', ['b', 'c'])).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it('separates the text from the choices so a shift between them changes the id', () => {
    // NUL-joining the fields keeps ('a', ['b','c']) distinct from ('a\0b', ['c'])
    expect(inlineQuestionId('a', ['bc'])).not.toBe(inlineQuestionId('a', ['b', 'c']));
    expect(inlineQuestionId('a', ['b', 'c'])).not.toBe(inlineQuestionId('a', ['b', 'd']));
    expect(inlineQuestionId('a', ['b', 'c'])).not.toBe(inlineQuestionId('x', ['b', 'c']));
  });
});

describe('pendingOmxQuestion', () => {
  const record = (over: Record<string, unknown> = {}) => JSON.stringify({
    kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting',
    question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }],
    renderer: { target: '%22', return_target: '%1' }, ...over
  });
  const withQuestionFile = async (contents: string, run: (workspace: string) => Promise<void>) => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-codex-q-'));
    try {
      const questions = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'q.json'), contents);
      await run(workspace);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  };

  it('reads a pending question addressed at the pane into the unified shape', async () => {
    await withQuestionFile(record(), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toEqual({
        id: inlineQuestionId('Choose one?', ['Yes', 'No']), text: 'Choose one?', choices: ['Yes', 'No'], source: 'structured', targetPaneId: '%22'
      });
    });
  });

  it('ignores a question addressed at another pane', async () => {
    await withQuestionFile(record({ renderer: { target: '%22', return_target: '%9' } }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('ignores a resolved question', async () => {
    await withQuestionFile(record({ status: 'answered' }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('ignores a question with fewer than two choices', async () => {
    await withQuestionFile(record({ options: [{ label: 'Only' }] }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('resolves to undefined when the workspace has no question files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-codex-noq-'));
    try {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
