import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptHistoryService } from '../src/prompt-history/service.js';

describe('PromptHistoryService', () => {
  it('persists newest-first prompt history independently for each worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-history-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      await service.record('worktree:cora', 'First prompt');
      await service.record('worktree:cora', 'Second prompt');
      await service.record('worktree:owen', 'Other prompt');

      await expect(new PromptHistoryService(file).list('worktree:cora')).resolves.toMatchObject([
        { text: 'Second prompt' },
        { text: 'First prompt' }
      ]);
      await expect(new PromptHistoryService(file).list('worktree:owen')).resolves.toMatchObject([{ text: 'Other prompt' }]);
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('worktree:cora');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // persist completed answers with their prompts
  it('records and reloads the final assistant answer for a prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      const entry = await service.record('worktree:cora', 'Explain the change');

      await expect(service.recordAnswer('worktree:cora', entry!.id, 'The change is complete.')).resolves.toMatchObject({
        id: entry!.id,
        answer: 'The change is complete.'
      });
      await expect(new PromptHistoryService(file).list('worktree:cora')).resolves.toMatchObject([{
        id: entry!.id,
        text: 'Explain the change',
        answer: 'The change is complete.'
      }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('clears a whole scope when its Worktree is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-clear-prompt-history-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      await service.record('worktree:cora', 'keep me');
      await service.record('worktree:dana', 'drop me');
      await service.clearScope('worktree:dana');
      expect(await service.list('worktree:dana')).toEqual([]);
      await expect(new PromptHistoryService(file).list('worktree:cora')).resolves.toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects invalid records and invalid persisted history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-prompt-history-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      await expect(service.record('worktree:cora', '')).resolves.toBeUndefined();
      await expect(service.recordAnswer('worktree:cora', 'missing-entry', 'Answer')).resolves.toBeUndefined();
      await writeFile(file, JSON.stringify({ 'worktree:cora': [{ id: 'bad', text: 'Prompt', createdAt: 'not-a-date' }] }));
      await expect(service.list('worktree:cora')).rejects.toThrow('invalid prompt history file');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('lists only the 50 most recent prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-history-limit-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      for (let index = 1; index <= 55; index += 1) await service.record('worktree:cora', `Prompt ${index}`);

      const history = await service.list('worktree:cora');
      expect(history).toHaveLength(50);
      expect(history?.at(0)?.text).toBe('Prompt 55');
      expect(history?.at(-1)?.text).toBe('Prompt 6');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
