import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type WorktreeNote = { id: string; text: string };
type StoredNotes = Record<string, WorktreeNote[]>;

const maxNotesPerWorktree = 50;
const maxWorktrees = 100;
const maxNoteLength = 30_000;
const maxTotalNoteLength = 300_000;
const validWorktreeId = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
const validNoteId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const validText = (value: string) => value.length <= maxNoteLength && !value.includes('\0');
const validNote = (value: unknown): value is WorktreeNote => {
  if (value === null || typeof value !== 'object') return false;
  const note = value as { id?: unknown; text?: unknown };
  return typeof note.id === 'string' && validNoteId(note.id) && typeof note.text === 'string' && validText(note.text);
};
const totalNoteLength = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + note.text.length, 0);

export class WorktreeNoteService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_NOTES_FILE ?? '.data/notes.json') {}

  async list(worktreeId: string): Promise<WorktreeNote[] | undefined> {
    if (!validWorktreeId(worktreeId)) return undefined;
    await this.mutation;
    return [...((await this.read())[worktreeId] ?? [])];
  }

  async create(worktreeId: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId)) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      if (notes.length >= maxNotesPerWorktree) return undefined;
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return undefined;
      const note = { id: randomBytes(18).toString('base64url'), text: '' };
      stored[worktreeId] = [note, ...notes];
      return note;
    });
  }

  async update(worktreeId: string, noteId: string, text: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validText(text)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      if (note === undefined) return undefined;
      if (totalNoteLength(stored) - note.text.length + text.length > maxTotalNoteLength) return undefined;
      note.text = text;
      return { ...note };
    });
  }

  async delete(worktreeId: string, noteId: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      const index = notes.findIndex(note => note.id === noteId);
      if (index < 0) return undefined;
      const [note] = notes.splice(index, 1);
      if (notes.length === 0) delete stored[worktreeId];
      return note;
    });
  }

  private async mutate<T>(change: (stored: StoredNotes) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = await change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredNotes> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const raw = JSON.parse(serialized) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid notes file');
    const stored: StoredNotes = {};
    for (const [worktreeId, notes] of Object.entries(raw)) {
      if (!validWorktreeId(worktreeId) || !Array.isArray(notes) || notes.length > maxNotesPerWorktree || notes.some(note => !validNote(note))) throw new Error('invalid notes file');
      stored[worktreeId] = notes;
    }
    if (Object.keys(stored).length > maxWorktrees || totalNoteLength(stored) > maxTotalNoteLength) throw new Error('notes file exceeds storage limits');
    return stored;
  }

  private async write(value: StoredNotes): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
