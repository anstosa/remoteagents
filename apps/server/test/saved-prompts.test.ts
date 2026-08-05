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

  it('persists attachment data while listing only attachment summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-saved-prompt-attachments-'));
    const file = join(directory, 'saved-prompts.json');
    const attachment = { name: 'release-notes.txt', data: Buffer.from('ship it').toString('base64') };
    try {
      const service = new SavedPromptService(file);
      const saved = await service.save('agent-one', '', [attachment]);

      expect(saved).toMatchObject({ text: '', attachments: [{ name: attachment.name, size: 7 }] });
      expect(saved?.attachments?.[0]).not.toHaveProperty('data');
      await expect(new SavedPromptService(file).list('agent-one')).resolves.toEqual([saved]);
      await expect(service.get('agent-one', saved!.id)).resolves.toEqual({ id: saved!.id, text: '', attachments: [attachment] });
      await expect(service.consume('agent-one', saved!.id)).resolves.toEqual({ id: saved!.id, text: '', attachments: [attachment] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed and duplicate attachments', async () => {
    const service = new SavedPromptService(join(tmpdir(), `rac-invalid-saved-prompts-${Date.now()}.json`));
    const valid = { name: 'details.txt', data: Buffer.from('details').toString('base64') };

    await expect(service.save('agent-one', 'Review', [{ name: 'bad.txt', data: 'not base64' }])).resolves.toBeUndefined();
    await expect(service.save('agent-one', 'Review', [valid, valid])).resolves.toBeUndefined();
  });

  it('enforces aggregate attachment budgets without discarding existing prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-saved-prompt-limits-'));
    const file = join(directory, 'saved-prompts.json');
    const service = new SavedPromptService(file, { text: 1_000, attachments: 10, attachmentsPerAgent: 8 });
    try {
      const first = await service.save('agent-one', '', [{ name: 'first.txt', data: Buffer.from('12345678').toString('base64') }]);
      await expect(service.save('agent-one', '', [{ name: 'overflow.txt', data: Buffer.from('x').toString('base64') }])).resolves.toBeUndefined();
      await expect(service.save('agent-two', '', [{ name: 'global.txt', data: Buffer.from('123').toString('base64') }])).resolves.toBeUndefined();
      await expect(service.list('agent-one')).resolves.toEqual([first]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes consume-on-success so a saved prompt is submitted only once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-saved-prompt-consume-'));
    const file = join(directory, 'saved-prompts.json');
    const service = new SavedPromptService(file);
    try {
      const saved = await service.save('agent-one', 'Queue once');
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let uses = 0;
      const first = service.consumeOnSuccess('agent-one', saved!.id, async () => { uses += 1; await held; return true; });
      const second = service.consumeOnSuccess('agent-one', saved!.id, async () => { uses += 1; return true; });
      release();
      await expect(first).resolves.toBe('consumed');
      await expect(second).resolves.toBe('missing');
      expect(uses).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
