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

  it('rejects invalid records and invalid persisted history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-prompt-history-'));
    const file = join(directory, 'history.json');
    try {
      const service = new PromptHistoryService(file);
      await expect(service.record('worktree:cora', '')).resolves.toBeUndefined();
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
