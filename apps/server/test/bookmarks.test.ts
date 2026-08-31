import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkService } from '../src/bookmarks/service.js';

describe('Codex bookmark persistence', () => {
  it('shares bookmarks by save key while preserving isolated groups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bookmark-groups-'));
    try {
      const file = join(directory, 'bookmarks.json');
      const service = new BookmarkService({ file });
      const shared = await service.create('potato', { threadId: '0198c444-4444-7444-8444-444444444444', title: 'Shared Potato chat', createdAt: '2026-08-20T20:00:00.000Z' });
      const isolated = await service.create('remoteagents', { threadId: '0198c555-5555-7555-8555-555555555555', title: 'Remote Agents chat', createdAt: '2026-08-20T21:00:00.000Z' });

      await expect(service.list('potato')).resolves.toEqual([shared]);
      await expect(service.get('potato', shared!.id)).resolves.toEqual(shared);
      await expect(service.list('remoteagents')).resolves.toEqual([isolated]);
      const renamed = await service.rename('potato', shared!.id, 'Renamed Potato chat');
      expect(renamed).toEqual({ ...shared, title: 'Renamed Potato chat' });
      await expect(service.rename('potato', shared!.id, '   ')).resolves.toBeUndefined();
      await expect(service.remove('potato', shared!.id)).resolves.toEqual(renamed);
      await expect(service.list('potato')).resolves.toEqual([]);
      await expect(new BookmarkService({ file }).list('remoteagents')).resolves.toEqual([isolated]);
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('remoteagents');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deduplicates the same conversation and omits a codex kind on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bookmark-dedupe-'));
    try {
      const file = join(directory, 'bookmarks.json');
      const service = new BookmarkService({ file });
      const first = await service.create('potato', { threadId: '0198c333-3333-7333-8333-333333333333', title: 'Only chat', createdAt: '2026-08-20T19:00:00.000Z' });
      const duplicate = await service.create('potato', { threadId: '0198c333-3333-7333-8333-333333333333', title: 'Renamed on disk', createdAt: '2026-08-20T19:30:00.000Z' });

      expect(duplicate).toEqual(first);
      await expect(service.list('potato')).resolves.toEqual([first]);
      // an absent kind keeps pre-existing bookmark files unchanged
      expect(first).not.toHaveProperty('kind');
      expect(JSON.parse(await readFile(file, 'utf8')).potato[0]).not.toHaveProperty('kind');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads a stored codex kind and rejects an unknown one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bookmark-kind-'));
    try {
      const file = join(directory, 'bookmarks.json');
      const valid = { id: 'abcdefabcdef012345', threadId: '0198c333-3333-7333-8333-333333333333', title: 'Codex chat', createdAt: '2026-08-20T19:00:00.000Z', kind: 'codex' };
      await writeFile(file, JSON.stringify({ potato: [valid] }));
      await expect(new BookmarkService({ file }).list('potato')).resolves.toEqual([valid]);

      const unknown = { ...valid, kind: 'gemini' };
      await writeFile(file, JSON.stringify({ potato: [unknown] }));
      await expect(new BookmarkService({ file }).list('potato')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe keys and malformed thread identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-bookmarks-'));
    try {
      const service = new BookmarkService({ file: join(directory, 'bookmarks.json') });

      await expect(service.list('bad/key')).resolves.toBeUndefined();
      await expect(service.create('cora', { threadId: 'not-a-session', title: 'Bad', createdAt: new Date().toISOString() })).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
