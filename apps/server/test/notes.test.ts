import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeNoteService } from '../src/notes/service.js';

describe('worktree notes', () => {
  // preserve attachment bytes across ordinary note mutations and reloads
  it('persists, appends and removes normalized attachments without autosave data loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachments-'));
    const file = join(directory, 'notes.json');
    const first = { name: ' context.txt ', data: Buffer.from('context').toString('base64') };
    const second = { name: 'diagram.png', data: Buffer.from('image').toString('base64') };
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.createWithText('cora', 'Attached note', '', undefined, [first]);
      expect(note?.attachments).toEqual([{ ...first, name: 'context.txt' }]);
      await expect(service.appendAttachments('cora', note!.id, [second])).resolves.toMatchObject({ attachments: [{ ...first, name: 'context.txt' }, second] });
      await service.update('cora', note!.id, 'Review both files');
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      await service.setSchedule('cora', note!.id, daily);
      await expect(new WorktreeNoteService(file).attachments('cora', note!.id)).resolves.toEqual([{ ...first, name: 'context.txt' }, second]);
      await expect(service.removeAttachment('cora', note!.id, ' context.txt ')).resolves.toMatchObject({ text: 'Review both files', schedule: daily, attachments: [second] });
      await service.removeSchedule('cora', note!.id);
      await expect(service.attachments('cora', note!.id)).resolves.toEqual([second]);
      await expect(service.delete('cora', note!.id)).resolves.toMatchObject({ attachments: [second] });
      await expect(service.attachments('cora', note!.id)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed, duplicate and over-budget attachment mutations atomically
  it('enforces attachment validation and the aggregate storage budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachment-limits-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file, 10);
      const first = { name: 'first.txt', data: Buffer.from('12345678').toString('base64') };
      const note = await service.createWithText('cora', 'Bounded', '', undefined, [first]);
      await expect(service.appendAttachments('cora', note!.id, [{ name: 'bad.txt', data: 'not base64' }])).resolves.toBe('invalid');
      await expect(service.appendAttachments('cora', note!.id, [{ name: 'first.txt', data: Buffer.from('x').toString('base64') }])).resolves.toBe('invalid');
      await expect(service.createWithText('owen', 'Overflow', '', undefined, [{ name: 'overflow.txt', data: Buffer.from('123').toString('base64') }])).resolves.toBeUndefined();
      await expect(service.attachments('cora', note!.id)).resolves.toEqual([{ name: 'first.txt', data: first.data }]);
      await expect(service.list('owen')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // accept legacy note records without attachments or deletion locks
  it('loads legacy note records without attachment or lock fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-legacy-notes-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Legacy', text: 'Still here' }] }));
      const [legacy] = (await new WorktreeNoteService(file).list('cora'))!;
      expect(legacy).toEqual({ id: 'note-identifier-000', title: 'Legacy', text: 'Still here' });
      expect(legacy?.locked).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // serialize lock transitions with deletion while preserving every other note field
  it('persists deletion locks and requires an atomic unlock before deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-locks-'));
    const file = join(directory, 'notes.json');
    const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.createWithText('cora', 'Protected note', 'Original text', 'queued-prompt', [attachment]);
      await service.setSchedule('cora', note!.id, daily);

      const [locked, refused] = await Promise.all([
        service.setLocked('cora', note!.id, true),
        service.delete('cora', note!.id)
      ]);
      expect(locked).toMatchObject({ ...note, schedule: daily, locked: true });
      expect(refused).toBe('locked');

      const restarted = new WorktreeNoteService(file);
      await expect(restarted.list('cora')).resolves.toMatchObject([{ ...note, schedule: daily, locked: true }]);
      await expect(restarted.update('cora', note!.id, 'Edited while locked')).resolves.toMatchObject({ text: 'Edited while locked', locked: true });
      await expect(restarted.rename('cora', note!.id, 'Renamed while locked')).resolves.toMatchObject({ title: 'Renamed while locked', locked: true });
      await expect(restarted.removeSchedule('cora', note!.id)).resolves.toMatchObject({ attachments: [attachment], locked: true });

      const [unlocked, deleted] = await Promise.all([
        restarted.setLocked('cora', note!.id, false),
        restarted.delete('cora', note!.id)
      ]);
      expect(unlocked).toMatchObject({ text: 'Edited while locked', title: 'Renamed while locked', attachments: [attachment] });
      expect(unlocked).not.toHaveProperty('locked');
      expect(deleted).toEqual(unlocked);
      await expect(new WorktreeNoteService(file).list('cora')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed persisted deletion locks
  it('rejects persisted non-boolean lock fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-note-lock-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Invalid', text: '', locked: 'yes' }] }));
      await expect(new WorktreeNoteService(file).list('cora')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed persisted attachment fields at the storage boundary
  it('rejects persisted null attachment fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-note-attachments-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Invalid', text: '', attachments: null }] }));
      await expect(new WorktreeNoteService(file).list('cora')).rejects.toThrow('invalid notes file');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


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

  it('sets, replaces and removes a note Schedule, and drops it when the note is deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-schedule-notes-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.create('cora', 'Morning triage');
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      await expect(service.setSchedule('cora', note!.id, daily)).resolves.toMatchObject({ id: note!.id, schedule: daily });
      // a persisted Schedule survives a fresh service reading the same file
      await expect(new WorktreeNoteService(file).list('cora')).resolves.toMatchObject([{ id: note!.id, schedule: daily }]);
      const paused = { ...daily, enabled: false, updatedAt: '2026-09-06T10:00:00-07:00' } as const;
      await expect(service.setSchedule('cora', note!.id, paused)).resolves.toMatchObject({ schedule: paused });
      await expect(service.removeSchedule('cora', note!.id)).resolves.toEqual({ id: note!.id, text: '', title: 'Morning triage' });
      // re-create a Schedule, then confirm deleting the note removes it
      await service.setSchedule('cora', note!.id, daily);
      await service.delete('cora', note!.id);
      await expect(service.list('cora')).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a structurally invalid Schedule and an unknown note', async () => {
    const service = new WorktreeNoteService(join(tmpdir(), `rac-schedule-bad-${Date.now()}.json`));
    const note = await service.create('cora');
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    await expect(service.setSchedule('cora', note!.id, { ...daily, kind: 'nope' } as never)).resolves.toBeUndefined();
    await expect(service.setSchedule('cora', note!.id, { ...daily, target: { worktreeId: '' } } as never)).resolves.toBeUndefined();
    await expect(service.setSchedule('cora', 'note-identifier-000', daily)).resolves.toBeUndefined();
    await expect(service.removeSchedule('cora', 'note-identifier-000')).resolves.toBeUndefined();
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

  it('creates a titled note with initial text in one mutation, respecting the aggregate budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-with-text-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const note = await service.createWithText('cora', 'Queued prompt in Cora · 9:41 AM', 'Draft the release notes.', 'queued-prompt');
      expect(note).toMatchObject({ title: 'Queued prompt in Cora · 9:41 AM', text: 'Draft the release notes.', source: 'queued-prompt' });
      await expect(new WorktreeNoteService(join(directory, 'notes.json')).list('cora')).resolves.toEqual([note]);
      await expect(service.rename('cora', note!.id, 'Release draft')).resolves.toMatchObject({ title: 'Release draft', source: 'queued-prompt' });
      // a blank title or over-budget text is refused, writing nothing
      await expect(service.createWithText('cora', '   ', 'text')).resolves.toBeUndefined();
      await expect(service.createWithText('cora', 'Too big', 'x'.repeat(300_000))).resolves.toBeUndefined();
      await expect(service.list('cora')).resolves.toEqual([{ ...note, title: 'Release draft' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('enumerates every scheduled note across all keys, and only scheduled ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scheduled-notes-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      const coraScheduled = await service.create('cora', 'Morning triage');
      await service.setSchedule('cora', coraScheduled!.id, daily);
      await service.create('cora', 'Plain note');
      const owenScheduled = await service.create('owen', 'Nightly summary');
      await service.setSchedule('owen', owenScheduled!.id, daily);
      const scheduled = await service.scheduled();
      expect(scheduled).toHaveLength(2);
      expect(scheduled.map(entry => ({ key: entry.key, id: entry.note.id })).sort((a, b) => a.key.localeCompare(b.key)))
        .toEqual([{ key: 'cora', id: coraScheduled!.id }, { key: 'owen', id: owenScheduled!.id }]);
      expect(scheduled.every(entry => entry.note.schedule !== undefined)).toBe(true);
      // an empty store enumerates to nothing
      await expect(new WorktreeNoteService(join(directory, 'empty.json')).scheduled()).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
