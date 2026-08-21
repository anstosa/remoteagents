import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexBookmarkService } from '../src/bookmarks/service.js';

// write one representative Codex session
async function writeSession(root: string, name: string, session: { id: string; cwd: string; timestamp: string; prompt: string; parentThreadId?: string }): Promise<string> {
  const directory = join(root, 'sessions', '2026', '08', '20');
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: session.id, cwd: session.cwd, timestamp: session.timestamp, originator: 'codex-tui', ...(session.parentThreadId === undefined ? {} : { parent_thread_id: session.parentThreadId }) } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: session.prompt }] } }
  ];
  const file = join(directory, name.replace(/\.jsonl$/u, `-${session.id}.jsonl`));
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

describe('Codex bookmarks', () => {
  it('bookmarks the selected agent conversation and deduplicates it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bookmarks-'));
    try {
      await writeSession(directory, 'rollout-2026-08-20T10-00-00-old.jsonl', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T17:00:00.000Z', prompt: 'Old task' });
      await writeSession(directory, 'rollout-2026-08-20T11-00-00-child.jsonl', { id: '0198c222-2222-7222-8222-222222222222', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T18:00:00.000Z', prompt: 'Child task', parentThreadId: '0198c111-1111-7111-8111-111111111111' });
      const current = await writeSession(directory, 'rollout-2026-08-20T12-00-00-current.jsonl', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T19:00:00.000Z', prompt: 'Add shared worktree bookmarks with a useful title' });
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });
      const selected = [{ id: '0198c333-3333-7333-8333-333333333333', relativePath: current.slice(directory.length + 1) }];

      const first = await service.bookmarkCurrent('potato', selected);
      const duplicate = await service.bookmarkCurrent('potato', selected);

      expect(first).toMatchObject({ threadId: '0198c333-3333-7333-8333-333333333333', title: 'Add shared worktree bookmarks with a useful title' });
      expect(duplicate).toEqual(first);
      await expect(service.list('potato')).resolves.toEqual([first]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('selects a resumed older rollout by exact thread identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-resumed-bookmark-'));
    try {
      const resumed = await writeSession(directory, 'rollout-2026-08-19T10-00-00-resumed.jsonl', { id: '0198c666-6666-7666-8666-666666666666', cwd: '/home/ubuntu/cora', timestamp: '2026-08-19T17:00:00.000Z', prompt: 'Resumed earlier conversation' });
      await writeSession(directory, 'rollout-2026-08-20T12-00-00-newer.jsonl', { id: '0198c777-7777-7777-8777-777777777777', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T19:00:00.000Z', prompt: 'Closed newer conversation' });
      await utimes(resumed, new Date('2099-08-21T01:00:00.000Z'), new Date('2099-08-21T01:00:00.000Z'));
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });

      const saved = await service.bookmarkCurrent('potato', [{ id: '0198c666-6666-7666-8666-666666666666', relativePath: resumed.slice(directory.length + 1) }]);

      expect(saved).toMatchObject({ threadId: '0198c666-6666-7666-8666-666666666666', title: 'Resumed earlier conversation' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous selected-agent session identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-ambiguous-bookmark-'));
    try {
      const first = await writeSession(directory, 'rollout-2026-08-20T10-00-00-first.jsonl', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T17:00:00.000Z', prompt: 'First open chat' });
      const second = await writeSession(directory, 'rollout-2026-08-20T11-00-00-second.jsonl', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T18:00:00.000Z', prompt: 'Second open chat' });
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });

      await expect(service.bookmarkCurrent('potato', [
        { id: '0198c111-1111-7111-8111-111111111111', relativePath: first.slice(directory.length + 1) },
        { id: '0198c333-3333-7333-8333-333333333333', relativePath: second.slice(directory.length + 1) }
      ])).resolves.toBeUndefined();
      await expect(service.list('potato')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('falls back to a thread label when the latest prompt is outside the bounded tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bounded-bookmark-'));
    try {
      const id = '0198c888-8888-7888-8888-888888888888';
      const file = await writeSession(directory, 'rollout-2026-08-20T12-00-00-large.jsonl', { id, cwd: '/home/ubuntu/cora', timestamp: '2026-08-20T19:00:00.000Z', prompt: 'Prompt outside the bounded tail' });
      await appendFile(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4_300_000) }] } })}\n`);
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });

      const saved = await service.bookmarkCurrent('potato', [{ id, relativePath: file.slice(directory.length + 1) }]);

      expect(saved).toMatchObject({ threadId: id, title: 'Codex chat 0198c888' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shares bookmarks by save key while preserving isolated groups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bookmark-groups-'));
    try {
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });
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
      await expect(new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory }).list('remoteagents')).resolves.toEqual([isolated]);
      expect(JSON.parse(await readFile(join(directory, 'bookmarks.json'), 'utf8'))).toHaveProperty('remoteagents');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe keys, session identifiers, and missing conversations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-bookmarks-'));
    try {
      const service = new CodexBookmarkService({ file: join(directory, 'bookmarks.json'), codexHome: directory });

      await expect(service.list('bad/key')).resolves.toBeUndefined();
      await expect(service.create('cora', { threadId: 'not-a-session', title: 'Bad', createdAt: new Date().toISOString() })).resolves.toBeUndefined();
      await expect(service.bookmarkCurrent('cora', [{ id: '0198c333-3333-7333-8333-333333333333', relativePath: 'sessions/2026/08/20/rollout-missing-0198c333-3333-7333-8333-333333333333.jsonl' }])).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
