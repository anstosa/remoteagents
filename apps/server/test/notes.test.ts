import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeNoteService } from '../src/notes/service.js';

describe('worktree notes', () => {
  it('persists isolated notes and serializes concurrent autosaves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-notes-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file);
      const first = await service.create('cora', 'Assistant setup');
      const second = await service.create('cora');
      await service.create('owen');
      await Promise.all([
        service.update('cora', first!.id, 'First draft'),
        service.update('cora', first!.id, 'Latest draft')
      ]);
      await service.rename('cora', first!.id, 'Deployment checklist');

      await expect(service.list('cora')).resolves.toEqual([second, { ...first, text: 'Latest draft', title: 'Deployment checklist' }]);
      await expect(new WorktreeNoteService(file).list('owen')).resolves.toMatchObject([{ text: '' }]);
      await expect(service.delete('cora', second!.id)).resolves.toEqual(second);
      await expect(service.list('cora')).resolves.toEqual([{ ...first, text: 'Latest draft', title: 'Deployment checklist' }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid identifiers and oversized content', async () => {
    const service = new WorktreeNoteService(join(tmpdir(), `rac-notes-${Date.now()}.json`));
    const note = await service.create('cora');
    await expect(service.list('bad/id')).resolves.toBeUndefined();
    await expect(service.update('cora', note!.id, 'x'.repeat(30_001))).resolves.toBeUndefined();
    await expect(service.update('cora', note!.id, 'bad\0note')).resolves.toBeUndefined();
    await expect(service.rename('cora', note!.id, '')).resolves.toBeUndefined();
    await expect(service.rename('cora', note!.id, 'x'.repeat(121))).resolves.toBeUndefined();
  });

  it('preserves a corrupt file instead of overwriting it during a mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-corrupt-notes-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, '{not valid json');
      const service = new WorktreeNoteService(file);
      await expect(service.create('cora')).rejects.toThrow();
      await expect(readFile(file, 'utf8')).resolves.toBe('{not valid json');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('enforces the aggregate note text budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bounded-notes-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const notes = await Promise.all(Array.from({ length: 11 }, () => service.create('cora')));
      for (const note of notes.slice(0, 10)) await expect(service.update('cora', note!.id, 'x'.repeat(30_000))).resolves.toBeDefined();
      await expect(service.update('cora', notes[10]!.id, 'overflow')).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
