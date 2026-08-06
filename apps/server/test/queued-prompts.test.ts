import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueuedPromptService } from '../src/prompts/queue.js';

describe('QueuedPromptService', () => {
  it('does not create storage while an empty queue is observed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-empty-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      await expect(service.next('worktree:cora')).resolves.toBeUndefined();
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('persists prompts and supports editing, reordering, and cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      const first = await service.enqueue('worktree:cora', 'First prompt');
      const second = await service.enqueue('worktree:cora', 'Second prompt', [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }]);
      expect(first).toBeDefined();
      expect(second).toMatchObject({ text: 'Second prompt', attachments: [{ name: 'context.txt', size: 7 }] });

      await expect(service.update('worktree:cora', second!.id, 'Edited second prompt')).resolves.toMatchObject({ text: 'Edited second prompt' });
      await expect(service.move('worktree:cora', second!.id, 'earlier')).resolves.toMatchObject([{ id: second!.id }, { id: first!.id }]);
      await expect(service.move('worktree:cora', second!.id, 'later')).resolves.toMatchObject([{ id: first!.id }, { id: second!.id }]);
      await expect(service.remove('worktree:cora', first!.id)).resolves.toMatchObject({ id: first!.id });

      await expect(new QueuedPromptService(file).list('worktree:cora')).resolves.toMatchObject([{ id: second!.id, text: 'Edited second prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('only removes a queued prompt after its consumer succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-consume-queued-prompts-'));
    const file = join(directory, 'queue.json');
    try {
      const service = new QueuedPromptService(file);
      const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
      const prompt = await service.enqueue('worktree:cora', 'Save this prompt', [attachment]);

      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async queued => {
        expect(queued).toMatchObject({ text: 'Save this prompt', attachments: [attachment] });
        return false;
      })).resolves.toBe('failed');
      await expect(service.list('worktree:cora')).resolves.toHaveLength(1);

      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async () => true)).resolves.toBe('consumed');
      await expect(service.list('worktree:cora')).resolves.toEqual([]);
      await expect(service.consumeOnSuccess('worktree:cora', prompt!.id, async () => true)).resolves.toBe('missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
