import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { ResetBoundaryStore, type ResetBoundary } from '../src/prompts/reset-boundaries.js';

const boundary: ResetBoundary = {
  id: 'boundary_1234567890',
  agentId: 'codex:worktree:cora',
  at: 1_789_000_000_000,
  before: { title: 'codex', attention: 'finished', conversationId: 'conversation-before-reset' },
  resetPromptId: 'reset_prompt_123456'
};

// verify durable reset boundaries
describe('ResetBoundaryStore', () => {
  // preserve boundaries across restarts
  it('persists cloned boundaries across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-'));
    const file = join(directory, 'resets.json');
    try {
      const store = new ResetBoundaryStore(file);
      await store.set('worktree:cora', boundary);
      const first = await store.get('worktree:cora');
      first!.before.title = 'mutated caller copy';

      await expect(store.get('worktree:cora')).resolves.toEqual(boundary);
      await expect(new ResetBoundaryStore(file).get('worktree:cora')).resolves.toEqual(boundary);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // isolate scope removal
  it('clears one scope without touching its sibling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-clear-'));
    const file = join(directory, 'queue.json');
    try {
      const queue = new QueuedPromptService(file);
      await queue.resets.set('worktree:cora', boundary);
      await queue.resets.set('worktree:dana', { ...boundary, agentId: 'codex:worktree:dana', external: true });

      await queue.clearScope('worktree:cora');

      const restored = new QueuedPromptService(file);
      await expect(restored.resets.get('worktree:cora')).resolves.toBeUndefined();
      await expect(restored.resets.get('worktree:dana')).resolves.toMatchObject({ agentId: 'codex:worktree:dana', external: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // protect replacement boundaries
  it('clears only the reset boundary version the caller observed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-conditional-'));
    const file = join(directory, 'resets.json');
    try {
      const store = new ResetBoundaryStore(file);
      await store.set('worktree:cora', boundary);

      await store.clear('worktree:cora', 'stale_boundary_1234');
      await expect(store.get('worktree:cora')).resolves.toEqual(boundary);
      await store.clear('worktree:cora', boundary.id);
      await expect(store.get('worktree:cora')).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // avoid empty sidecar writes
  it('does not create storage when an absent scope is cleared', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-empty-'));
    const file = join(directory, 'resets.json');
    try {
      await new ResetBoundaryStore(file).clear('worktree:cora');
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // reject every malformed persisted field
  it.each([
    { name: 'scope', scope: '', value: boundary },
    { name: 'id', scope: 'worktree:cora', value: { ...boundary, id: 'short' } },
    { name: 'reset prompt id', scope: 'worktree:cora', value: { ...boundary, resetPromptId: 'short' } },
    { name: 'agent id', scope: 'worktree:cora', value: { ...boundary, agentId: '' } },
    { name: 'timestamp', scope: 'worktree:cora', value: { ...boundary, at: -1 } },
    { name: 'title', scope: 'worktree:cora', value: { ...boundary, before: { ...boundary.before, title: '\0' } } },
    { name: 'attention', scope: 'worktree:cora', value: { ...boundary, before: { ...boundary.before, attention: 'idle' } } },
    { name: 'conversation id', scope: 'worktree:cora', value: { ...boundary, before: { ...boundary.before, conversationId: '' } } },
    { name: 'external marker', scope: 'worktree:cora', value: { ...boundary, external: 'yes' } }
  ])('rejects an invalid persisted $name', async ({ scope, value }) => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-invalid-'));
    const file = join(directory, 'resets.json');
    try {
      await writeFile(file, JSON.stringify({ [scope]: value }));
      await expect(new ResetBoundaryStore(file).get('worktree:cora')).rejects.toThrow('invalid reset boundaries file');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // enforce the scope cap
  it('rejects a new scope after reaching the durable scope cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-limit-'));
    const file = join(directory, 'resets.json');
    try {
      // fill every allowed scope
      const stored = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`worktree:${index}`, boundary]));
      await writeFile(file, JSON.stringify(stored));
      const store = new ResetBoundaryStore(file);

      await expect(store.set('worktree:overflow', boundary)).rejects.toThrow('reset boundaries file exceeds storage limits');
      await expect(store.get('worktree:0')).resolves.toEqual(boundary);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // retain only durable cache state
  it('does not cache a boundary when its durable write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reset-boundaries-failure-'));
    const file = join(directory, 'resets.json');
    try {
      const store = new ResetBoundaryStore(file);
      await expect(store.get('worktree:cora')).resolves.toBeUndefined();
      await mkdir(file);
      await expect(store.set('worktree:cora', boundary)).rejects.toBeDefined();
      await rm(file, { recursive: true, force: true });

      await expect(store.get('worktree:cora')).resolves.toBeUndefined();
      await expect(readFile(`${file}.next`, 'utf8')).resolves.toContain('codex:worktree:cora');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
