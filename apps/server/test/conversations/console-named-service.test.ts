import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConsoleNamedConversationService } from '../../src/conversations/console-named-service.js';

const claudeId = '11111111-2222-4333-8444-555555555555';
const otherClaudeId = '22222222-3333-4333-8444-555555555555';
const codexId = '0198c555-5555-7555-8555-555555555555';

describe('console-named conversation persistence', () => {
  it('shares records by save key while preserving isolated groups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-groups-'));
    try {
      const file = join(directory, 'console-named.json');
      const service = new ConsoleNamedConversationService({ file });
      const potato = await service.record('potato', { kind: 'claude', id: claudeId, namedAt: '2026-09-01T10:00:00.000Z' });
      const remote = await service.record('remoteagents', { kind: 'codex', id: codexId, namedAt: '2026-09-01T11:00:00.000Z' });

      expect(potato).toEqual({ kind: 'claude', id: claudeId, namedAt: '2026-09-01T10:00:00.000Z' });
      await expect(service.list('potato')).resolves.toEqual([potato]);
      await expect(service.list('remoteagents')).resolves.toEqual([remote]);
      // a fresh service reads the persisted file back
      await expect(new ConsoleNamedConversationService({ file }).list('remoteagents')).resolves.toEqual([remote]);
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('potato');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps one record per Conversation, refreshing namedAt and moving it to the front', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-dedupe-'));
    try {
      const service = new ConsoleNamedConversationService({ file: join(directory, 'console-named.json') });
      await service.record('potato', { kind: 'claude', id: claudeId, namedAt: '2026-09-01T10:00:00.000Z' });
      await service.record('potato', { kind: 'claude', id: otherClaudeId, namedAt: '2026-09-01T11:00:00.000Z' });
      // naming the first Conversation again refreshes it and moves it ahead of the second
      const refreshed = await service.record('potato', { kind: 'claude', id: claudeId, namedAt: '2026-09-01T12:00:00.000Z' });

      const listed = await service.list('potato');
      expect(listed).toEqual([
        refreshed,
        { kind: 'claude', id: otherClaudeId, namedAt: '2026-09-01T11:00:00.000Z' },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats a codex-family rollout named under either wrapper as one record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-codex-'));
    try {
      const service = new ConsoleNamedConversationService({ file: join(directory, 'console-named.json') });
      await service.record('potato', { kind: 'codex', id: codexId, namedAt: '2026-09-01T10:00:00.000Z' });
      // the same rollout resumed and renamed under OMX replaces the Codex record, not adds a second
      const asOmx = await service.record('potato', { kind: 'omx', id: codexId, namedAt: '2026-09-01T11:00:00.000Z' });
      await expect(service.list('potato')).resolves.toEqual([asOmx]);
      // and removing it by the other wrapper still forgets it (matched by id across the pair)
      await expect(service.remove('potato', 'codex', codexId)).resolves.toBe(true);
      await expect(service.list('potato')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps a key at 100 records, dropping the oldest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-cap-'));
    try {
      const service = new ConsoleNamedConversationService({ file: join(directory, 'console-named.json') });
      // 101 distinct Conversations; the very first must fall off the end
      for (let index = 0; index < 101; index += 1) {
        const id = `0198c555-5555-7555-8555-${index.toString().padStart(12, '0')}`;
        await service.record('potato', { kind: 'codex', id, namedAt: new Date(1_800_000_000_000 + index).toISOString() });
      }
      const listed = await service.list('potato');
      expect(listed).toHaveLength(100);
      // the oldest (index 0) was dropped; the newest (index 100) is at the front
      expect(listed?.some(record => record.id.endsWith('000000000000'))).toBe(false);
      expect(listed?.[0]?.id).toBe('0198c555-5555-7555-8555-000000000100');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes only the matching record and rejects unsafe keys or invalid ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-remove-'));
    try {
      const service = new ConsoleNamedConversationService({ file: join(directory, 'console-named.json') });
      await service.record('potato', { kind: 'claude', id: claudeId });
      await service.record('potato', { kind: 'claude', id: otherClaudeId });

      // removing an absent record leaves the group untouched
      await expect(service.remove('potato', 'claude', codexId)).resolves.toBe(false);
      await expect(service.remove('potato', 'claude', claudeId)).resolves.toBe(true);
      expect((await service.list('potato'))?.map(record => record.id)).toEqual([otherClaudeId]);

      // an unsafe key never resolves, and an invalid id is rejected on record
      await expect(service.list('bad/key')).resolves.toBeUndefined();
      await expect(service.record('cora', { kind: 'claude', id: 'not-a-uuid' })).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a corrupt store file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-console-named-corrupt-'));
    try {
      const file = join(directory, 'console-named.json');
      await writeFile(file, JSON.stringify({ potato: [{ kind: 'gemini', id: claudeId, namedAt: '2026-09-01T10:00:00.000Z' }] }));
      await expect(new ConsoleNamedConversationService({ file }).list('potato')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
