import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SavedPromptService } from '../src/saved-prompts/service.js';

describe('saved prompts', () => {
  it('persists prompts per agent and consumes a selected prompt exactly once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-saved-prompts-'));
    const file = join(directory, 'saved-prompts.json');
    try {
      const service = new SavedPromptService(file);
      const first = await service.save('agent-one', 'First reusable prompt');
      const second = await service.save('agent-one', 'Second reusable prompt');
      await service.save('agent-two', 'Other agent prompt');

      await expect(service.list('agent-one')).resolves.toEqual([second, first]);
      await expect(new SavedPromptService(file).list('agent-two')).resolves.toMatchObject([{ text: 'Other agent prompt' }]);
      await expect(service.consume('agent-one', first!.id)).resolves.toEqual(first);
      await expect(service.consume('agent-one', first!.id)).resolves.toBeUndefined();
      await expect(service.list('agent-one')).resolves.toEqual([second]);
      await expect(service.list('agent-two')).resolves.toMatchObject([{ text: 'Other agent prompt' }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects empty and oversized messages', async () => {
    const service = new SavedPromptService(join(tmpdir(), `rac-saved-prompts-${Date.now()}.json`));

    await expect(service.save('agent-one', '   ')).resolves.toBeUndefined();
    await expect(service.save('agent-one', 'x'.repeat(32_001))).resolves.toBeUndefined();
  });
});
