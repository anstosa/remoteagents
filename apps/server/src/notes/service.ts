import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promptAttachmentBytes, promptAttachmentName, validPromptAttachments, type PromptAttachment } from '../prompts/validation.js';
import { type Schedule, type ScheduleLastRun, validSchedule } from '../schedule/types.js';

export type WorktreeNote = { id: string; text: string; title?: string; source?: 'queued-prompt'; schedule?: Schedule; attachments?: PromptAttachment[]; locked?: boolean };
type StoredNotes = Record<string, WorktreeNote[]>;

const maxNotesPerWorktree = 50;
const maxWorktrees = 100;
const maxNoteLength = 30_000;
const defaultAttachmentStorageLimit = 100 * 1024 * 1024;
// the note-title cap; exported so the saved-prompts boot migration truncates to the same limit
export const maxNoteTitleLength = 120;
const maxTotalNoteLength = 300_000;
const validWorktreeId = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
const validNoteId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const validText = (value: string) => value.length <= maxNoteLength && !value.includes('\0');
const validTitle = (value: string) => value.trim().length > 0 && value.length <= maxNoteTitleLength && !value.includes('\0');
// canonicalize names before persistence
const normalizedAttachments = (attachments: PromptAttachment[]): PromptAttachment[] | undefined => {
  const normalized: PromptAttachment[] = [];
  // normalize every stored filename
  for (const attachment of attachments) {
    const name = promptAttachmentName(attachment.name);
    // reject malformed filenames
    if (name === undefined) return undefined;
    normalized.push({ name, data: attachment.data });
  }
  // enforce prompt attachment limits
  return validPromptAttachments(normalized) ? normalized : undefined;
};
// validate persisted note data
const validNote = (value: unknown): value is WorktreeNote => {
  if (value === null || typeof value !== 'object') return false;
  const note = value as { id?: unknown; text?: unknown; title?: unknown; source?: unknown; schedule?: unknown; attachments?: unknown; locked?: unknown };
  const attachments = note.attachments === undefined ? [] : note.attachments;
  return typeof note.id === 'string' && validNoteId(note.id) && typeof note.text === 'string' && validText(note.text) && (note.title === undefined || typeof note.title === 'string' && validTitle(note.title)) && (note.source === undefined || note.source === 'queued-prompt') && (note.schedule === undefined || validSchedule(note.schedule)) && (note.locked === undefined || typeof note.locked === 'boolean') && Array.isArray(attachments) && attachments.every(attachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' && typeof (attachment as { data?: unknown }).data === 'string') && validPromptAttachments(attachments as PromptAttachment[]) && (attachments as PromptAttachment[]).every(attachment => promptAttachmentName(attachment.name) === attachment.name);
};
const totalNoteLength = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + note.text.length + (note.title?.length ?? 0), 0);
// total decoded attachment bytes
const totalAttachmentBytes = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + (note.attachments ?? []).reduce((sum, attachment) => sum + (promptAttachmentBytes(attachment) ?? 0), 0), 0);

export class WorktreeNoteService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_NOTES_FILE ?? '.data/notes.json', private readonly attachmentStorageLimit = defaultAttachmentStorageLimit) {}

  async list(worktreeId: string): Promise<WorktreeNote[] | undefined> {
    if (!validWorktreeId(worktreeId)) return undefined;
    await this.mutation;
    return [...((await this.read())[worktreeId] ?? [])];
  }

  // every scheduled note across all keys, paired with its persistence key — the scheduler's
  // enumeration for one tick. Only notes that carry a Schedule are returned.
  async scheduled(): Promise<Array<{ key: string; note: WorktreeNote }>> {
    await this.mutation;
    const stored = await this.read();
    return Object.entries(stored).flatMap(([key, notes]) =>
      notes.filter(note => note.schedule !== undefined).map(note => ({ key, note })));
  }

  // create an optionally titled note
  async create(worktreeId: string, title?: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || title !== undefined && !validTitle(title)) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      if (notes.length >= maxNotesPerWorktree) return undefined;
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return undefined;
      const note: WorktreeNote = { id: randomBytes(18).toString('base64url'), text: '', ...(title === undefined ? {} : { title }) };
      if (totalNoteLength(stored) + (title?.length ?? 0) > maxTotalNoteLength) return undefined;
      stored[worktreeId] = [note, ...notes];
      return note;
    });
  }

  // create a titled note with initial text in one mutation — the save-as-note and halt-drain
  // paths write the note atomically before consuming the queued prompt, so a two-step
  // create-then-update (which could leave a blank titled note on failure) will not do
  async createWithText(worktreeId: string, title: string, text: string, source?: 'queued-prompt', attachments: PromptAttachment[] = []): Promise<WorktreeNote | undefined> {
    const normalized = normalizedAttachments(attachments);
    // reject invalid note content
    if (!validWorktreeId(worktreeId) || !validTitle(title) || !validText(text) || normalized === undefined) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      if (notes.length >= maxNotesPerWorktree) return undefined;
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return undefined;
      if (totalNoteLength(stored) + title.length + text.length > maxTotalNoteLength) return undefined;
      // enforce the global byte budget
      if (totalAttachmentBytes(stored) + normalized.reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0) > this.attachmentStorageLimit) return undefined;
      const note: WorktreeNote = { id: randomBytes(18).toString('base64url'), text, title, ...(source === undefined ? {} : { source }), ...(normalized.length === 0 ? {} : { attachments: normalized }) };
      stored[worktreeId] = [note, ...notes];
      return note;
    });
  }

  // read full attachment payloads for one note
  async attachments(worktreeId: string, noteId: string): Promise<PromptAttachment[] | undefined> {
    // reject invalid identifiers
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    await this.mutation;
    const note = (await this.read())[worktreeId]?.find(candidate => candidate.id === noteId);
    return note === undefined ? undefined : [...(note.attachments ?? [])];
  }

  // append attachments atomically
  async appendAttachments(worktreeId: string, noteId: string, attachments: PromptAttachment[]): Promise<WorktreeNote | 'invalid' | undefined> {
    const normalized = normalizedAttachments(attachments);
    // reject malformed additions
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || normalized === undefined || normalized.length === 0) return 'invalid';
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      // require an existing note
      if (note === undefined) return undefined;
      const combined = normalizedAttachments([...(note.attachments ?? []), ...normalized]);
      // enforce per-note limits and duplicate names
      if (combined === undefined) return 'invalid';
      const previousBytes = (note.attachments ?? []).reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0);
      const nextBytes = combined.reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0);
      // enforce the global byte budget
      if (totalAttachmentBytes(stored) - previousBytes + nextBytes > this.attachmentStorageLimit) return 'invalid';
      note.attachments = combined;
      return { ...note };
    });
  }

  // remove one canonical attachment name atomically
  async removeAttachment(worktreeId: string, noteId: string, name: string): Promise<WorktreeNote | undefined> {
    const normalizedName = promptAttachmentName(name);
    // reject invalid identifiers and names
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || normalizedName === undefined) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      // require an existing matching attachment
      if (note === undefined || note.attachments === undefined) return undefined;
      const next = note.attachments.filter(attachment => attachment.name !== normalizedName);
      if (next.length === note.attachments.length) return undefined;
      // omit empty attachment arrays
      if (next.length === 0) delete note.attachments;
      else note.attachments = next;
      return { ...note };
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

  // rename one note
  async rename(worktreeId: string, noteId: string, title: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validTitle(title)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      if (note === undefined) return undefined;
      if (totalNoteLength(stored) - (note.title?.length ?? 0) + title.length > maxTotalNoteLength) return undefined;
      note.title = title;
      return { ...note };
    });
  }

  // set one note's deletion lock without changing its editable content or metadata
  async setLocked(worktreeId: string, noteId: string, locked: boolean): Promise<WorktreeNote | undefined> {
    // reject invalid identifiers
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      // require an existing note
      if (note === undefined) return undefined;
      // omit the false default for legacy-compatible storage
      if (locked) note.locked = true;
      else delete note.locked;
      return { ...note };
    });
  }

  // delete only an unlocked note in the serialized mutation boundary
  async delete(worktreeId: string, noteId: string): Promise<WorktreeNote | 'locked' | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      const index = notes.findIndex(note => note.id === noteId);
      if (index < 0) return undefined;
      // refuse locks before changing the stored collection
      if (notes[index]!.locked === true) return 'locked';
      const [note] = notes.splice(index, 1);
      if (notes.length === 0) delete stored[worktreeId];
      return note;
    });
  }

  // set or replace one note's Schedule; validates the record's shape (the route validates
  // target existence and cron parseability, which this store cannot see)
  async setSchedule(worktreeId: string, noteId: string, schedule: Schedule): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validSchedule(schedule)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      if (note === undefined) return undefined;
      note.schedule = schedule;
      return { ...note };
    });
  }

  // record the outcome of one Run on a note's Schedule; a note without a Schedule is left
  // untouched (undefined), since only a scheduled note has a `lastRun` to write
  async recordLastRun(worktreeId: string, noteId: string, lastRun: ScheduleLastRun): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      if (note === undefined || note.schedule === undefined) return undefined;
      note.schedule = { ...note.schedule, lastRun };
      return { ...note };
    });
  }

  // remove one note's Schedule, keeping the note
  async removeSchedule(worktreeId: string, noteId: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = stored[worktreeId]?.find(candidate => candidate.id === noteId);
      if (note === undefined) return undefined;
      delete note.schedule;
      return { ...note };
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
    if (Object.keys(stored).length > maxWorktrees || totalNoteLength(stored) > maxTotalNoteLength || totalAttachmentBytes(stored) > this.attachmentStorageLimit) throw new Error('notes file exceeds storage limits');
    return stored;
  }

  private async write(value: StoredNotes): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
