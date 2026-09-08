import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeNoteService } from '../src/notes/service.js';
import { formatSavedPromptsToNotes, migrateSavedPromptsToNotes } from '../src/migrations/saved-prompts-to-notes.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); } });
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false);

// a temp saved-prompts file and a temp notes file, isolated per test
async function tempFiles() {
  const dir = await mkdtemp(join(tmpdir(), 'rac-saved-to-notes-'));
  dirs.push(dir);
  return { dir, savedFile: join(dir, 'saved-prompts.json'), notesFile: join(dir, 'notes.json') };
}

describe('migrateSavedPromptsToNotes', () => {
  it('migrates project-keyed saved prompts into notes, backs up the file, and a second boot is a no-op', async () => {
    const { savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({
      'proj:/repo/wts/main': [
        { id: 'sp0000000001', text: 'Morning triage of the repo' },
        { id: 'sp0000000002', text: 'Nightly summary\nof the day' }
      ]
    }));
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    // both prompts become notes under the bare Project id; the title is the first non-blank line
    const stored = await notes.list('proj');
    expect(stored).toHaveLength(2);
    expect(stored?.map(note => ({ title: note.title, text: note.text }))).toEqual(expect.arrayContaining([
      { title: 'Morning triage of the repo', text: 'Morning triage of the repo' },
      { title: 'Nightly summary', text: 'Nightly summary\nof the day' }
    ]));
    // the source file is renamed to a sibling backup
    expect(await exists(savedFile)).toBe(false);
    expect(await exists(`${savedFile}.migrated-to-notes.bak`)).toBe(true);
    expect(report.counts).toEqual({ proj: 2 });
    expect(report.backups).toEqual([`${savedFile}.migrated-to-notes.bak`]);
    expect(report.warnings).toEqual([]);
    // one line per migrated key and a backup line
    expect(formatSavedPromptsToNotes(report)).toEqual([
      'saved prompts → notes: 2 notes under proj',
      `backup ${savedFile}.migrated-to-notes.bak`
    ]);

    // a second boot finds no source file and does nothing
    const second = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });
    expect(second).toEqual({ counts: {}, backups: [], warnings: [] });
    expect(await notes.list('proj')).toHaveLength(2);
  });

  it('skips a key with no configured project, naming it in the log, and numbers an attachment-only prompt', async () => {
    const { savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({
      'proj:/repo/wts/main': [
        { id: 'sp0000000001', text: '', attachments: [{ name: 'diagram.png', data: 'AAAA' }] }
      ],
      'agent-oldpane': [
        { id: 'sp0000000009', text: 'orphaned scratch prompt' }
      ]
    }));
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    // the attachment-only prompt gets a numbered title and its attachment name in the text
    expect(await notes.list('proj')).toEqual([{ id: expect.any(String), title: 'Saved prompt · 1', text: 'Dropped attachments: diagram.png' }]);
    expect(report.counts).toEqual({ proj: 1 });
    // the stale agent-id key is skipped and named in the log
    expect(formatSavedPromptsToNotes(report)).toContain('warning: key agent-oldpane has no configured project; 1 saved prompt not migrated');
  });

  it('leaves the source file in place and logs the problem when the file is corrupt', async () => {
    const { savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, '{ not valid json');
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    // the source is untouched, nothing is backed up, and no notes are written
    expect(await readFile(savedFile, 'utf8')).toBe('{ not valid json');
    expect(await exists(`${savedFile}.migrated-to-notes.bak`)).toBe(false);
    expect(report.counts).toEqual({});
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(formatSavedPromptsToNotes(report).some(line => line.startsWith('warning:'))).toBe(true);
  });

  it('moves the source to the backup before writing notes, so a failed write cannot re-migrate', async () => {
    const { savedFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({ 'proj:/repo': [
      { id: 'sp0000000001', text: 'first' },
      { id: 'sp0000000002', text: 'second' }
    ] }));
    // a notes service whose second write throws: with write-then-move the source would stay and a
    // reboot would re-migrate (duplicating); move-first has already moved it aside, so a retry is a no-op
    let calls = 0;
    const notes = { createWithText: async () => { calls += 1; if (calls === 2) throw new Error('disk full'); return { id: 'sp0000000001', text: 'first', title: 'first' }; } } as unknown as WorktreeNoteService;

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    expect(calls).toBe(2);
    // the source moved to the backup before the failing write, so a second boot finds nothing
    expect(await exists(savedFile)).toBe(false);
    expect(await exists(`${savedFile}.migrated-to-notes.bak`)).toBe(true);
    expect(report.warnings.some(warning => warning.includes('preserved in the backup'))).toBe(true);
  });

  it('writes no notes and leaves the source in place when the backup move fails', async () => {
    const { dir, savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({ 'proj:/repo': [{ id: 'sp0000000001', text: 'keep me' }] }));
    const notes = new WorktreeNoteService(notesFile);
    // a read-only directory: the backup link cannot be created, so the move fails before any write
    await chmod(dir, 0o555);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    // the source is untouched, nothing is backed up, and no notes were written — so a retry is safe
    expect(await exists(savedFile)).toBe(true);
    expect(await exists(`${savedFile}.migrated-to-notes.bak`)).toBe(false);
    expect(report.counts).toEqual({});
    expect(await notes.list('proj')).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('counts prompts that exceed the notes limits and still migrates and backs up the rest', async () => {
    const { savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({
      'proj:/repo/wts/main': [
        { id: 'sp0000000001', text: 'keep me' },
        { id: 'sp0000000002', text: 'x'.repeat(31_000) }
      ]
    }));
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    expect((await notes.list('proj'))?.map(note => note.title)).toEqual(['keep me']);
    expect(report.counts).toEqual({ proj: 1 });
    expect(formatSavedPromptsToNotes(report)).toContain('warning: 1 saved prompt exceeded the notes limits and was not migrated');
    // an over-limit record is counted, not a failure: the file is still moved to its backup
    expect(await exists(`${savedFile}.migrated-to-notes.bak`)).toBe(true);
  });

  it('never overwrites an existing backup, moving the source to the next free name', async () => {
    const { savedFile, notesFile } = await tempFiles();
    await writeFile(savedFile, JSON.stringify({ 'proj:/repo': [{ id: 'sp0000000001', text: 'hi' }] }));
    await writeFile(`${savedFile}.migrated-to-notes.bak`, 'OLD BACKUP');
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    expect(await readFile(`${savedFile}.migrated-to-notes.bak`, 'utf8')).toBe('OLD BACKUP');
    expect(report.backups).toEqual([`${savedFile}.migrated-to-notes.bak.1`]);
    expect(await exists(savedFile)).toBe(false);
  });

  it('does nothing when there is no saved-prompts file', async () => {
    const { savedFile, notesFile } = await tempFiles();
    const notes = new WorktreeNoteService(notesFile);

    const report = await migrateSavedPromptsToNotes({ projectIds: ['proj'], notes, savedPromptsFile: savedFile });

    expect(report).toEqual({ counts: {}, backups: [], warnings: [] });
    expect(formatSavedPromptsToNotes(report)).toEqual([]);
  });
});
