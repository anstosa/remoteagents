import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// count real filesystem work without replacing its change semantics
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile), readdir: vi.fn(fs.readdir) };
});
import { pendingOmxQuestion } from '../../src/adapters/omx-questions.js';

const roots: string[] = [];
// isolate fixtures and call counts between examples
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.mocked(readFile).mockReset();
  vi.mocked(readdir).mockClear();
});

// keep the normal OMX transport schema in each fixture
const record = (pane = '%1', overrides: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting',
  question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }],
  renderer: { target: '%22', return_target: pane }, ...overrides
});

// create one workspace with a root question
async function fixture(): Promise<{ workspace: string; file: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'rac-question-index-'));
  roots.push(workspace);
  const directory = join(workspace, '.omx', 'state', 'questions');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'q.json');
  await writeFile(file, record());
  return { workspace, file };
}

describe('workspace question index', () => {
  // all panes in a workspace share one inventory and parsed question set
  it('coalesces a workspace scan and reuses unchanged file results on later scans', async () => {
    const { workspace } = await fixture();
    const directory = join(workspace, '.omx', 'state', 'sessions', 'session-a', 'questions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'q.json'), record('%2', { question: 'Another question?' }));
    const results = await Promise.all(['%1', '%2', '%3', '%4'].map(pane => pendingOmxQuestion(workspace, pane)));
    expect(results.map(question => question?.text)).toEqual(['Choose one?', 'Another question?', undefined, undefined]);
    expect(readdir).toHaveBeenCalledTimes(3);
    expect(readFile).toHaveBeenCalledTimes(2);
    await pendingOmxQuestion(workspace, '%1');
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readdir).toHaveBeenCalledTimes(6);
  });

  // edits must be visible to answer validation without a cache timeout
  it('observes answers, malformed rewrites, repairs, replacements and deletion immediately', async () => {
    const { workspace, file } = await fixture();
    expect(await pendingOmxQuestion(workspace, '%1')).toBeDefined();
    await writeFile(file, record('%1', { status: 'answered' }));
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    await writeFile(file, '{');
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    await writeFile(file, 'null');
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    await writeFile(`${file}.new`, record('%1', { question: 'Replacement?' }));
    await rename(`${file}.new`, file);
    expect((await pendingOmxQuestion(workspace, '%1'))?.text).toBe('Replacement?');
    await rm(file);
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    await writeFile(file, record());
    expect(await pendingOmxQuestion(workspace, '%1')).toBeDefined();
  });

  // new session directories remain discoverable after an empty scan
  it('discovers newly created session questions and drops removed sessions', async () => {
    const { workspace, file } = await fixture();
    await rm(file);
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    const directory = join(workspace, '.omx', 'state', 'sessions', 'new-session', 'questions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'q.json'), record());
    expect(await pendingOmxQuestion(workspace, '%1')).toBeDefined();
    await rm(join(directory, '..'), { recursive: true });
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
  });

  // retain root-before-session precedence and isolate equal pane ids
  it('preserves first-valid question precedence and separates workspaces', async () => {
    const first = await fixture(); const second = await fixture();
    await writeFile(second.file, record('%1', { question: 'Other workspace?' }));
    const directory = join(first.workspace, '.omx', 'state', 'sessions', 'session', 'questions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'q.json'), record('%1', { question: 'Session question?' }));
    const results = await Promise.all([pendingOmxQuestion(first.workspace, '%1'), pendingOmxQuestion(second.workspace, '%1')]);
    expect(results.map(question => question?.text)).toEqual(['Choose one?', 'Other workspace?']);
    await writeFile(first.file, record('%1', { status: 'answered' }));
    expect((await pendingOmxQuestion(first.workspace, '%1'))?.text).toBe('Session question?');
  });

  // temporary read errors are not cached as resolved questions
  it('retries unreadable files and protects retained questions from caller mutation', async () => {
    const { workspace } = await fixture();
    vi.mocked(readFile).mockRejectedValueOnce(new Error('temporary read failure'));
    expect(await pendingOmxQuestion(workspace, '%1')).toBeUndefined();
    const question = await pendingOmxQuestion(workspace, '%1');
    expect(question?.choices).toEqual(['Yes', 'No']);
    question!.choices[0] = 'mutated';
    expect((await pendingOmxQuestion(workspace, '%1'))?.choices).toEqual(['Yes', 'No']);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  // an answered candidate must neither return nor hide its still-pending successor
  it.each([
    { laterPane: '%2', expectedText: undefined },
    { laterPane: '%1', expectedText: 'Next question?' }
  ])('revalidates shared candidates with a later question for $laterPane', async ({ laterPane, expectedText }) => {
    const { workspace, file } = await fixture();
    const directory = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
    await mkdir(directory, { recursive: true });
    const slowFile = join(directory, 'q.json');
    await writeFile(slowFile, record(laterPane, { question: 'Next question?' }));
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    // pause only after the first question has already entered the shared index
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
      // hold the later file while an operator resolves the earlier question
      if (args[0] === slowFile) { started(); await gate; }
      return fs.readFile(...args);
    });
    const dashboard = pendingOmxQuestion(workspace, '%1');
    await ready;
    await writeFile(file, record('%1', { status: 'answered' }));
    const answer = pendingOmxQuestion(workspace, '%1');
    release();
    expect((await answer)?.text).toBe(expectedText);
    expect((await dashboard)?.text).toBe(expectedText);
  });
});
