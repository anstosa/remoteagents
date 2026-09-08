import { link, readFile, unlink } from 'node:fs/promises';
import { maxNoteTitleLength, WorktreeNoteService } from '../notes/service.js';
import { noteTextWithDroppedAttachments } from '../notes/from-prompt.js';
import { projectIdOf } from '../workspaces/resolver.js';

/**
 * What the boot migration of saved prompts into Notes did, in the report shape the projects
 * migration uses (per-key counts of records written, the backups it left, and one warning per
 * problem). Rendered to boot-log lines by {@link formatSavedPromptsToNotes}.
 */
export type SavedPromptsToNotesReport = {
  counts: Record<string, number>;  // destination Project id → notes created
  backups: string[];               // the renamed saved-prompts file, when one was moved
  warnings: string[];              // one per skipped key, an over-limit count, and any failure
};

// a leniently-parsed saved prompt: only the text and any attachment names carry into a Note
type ParsedPrompt = { text: string; attachments: string[] };

// the migration's report as boot-log lines, matching migrations/boot.ts formatReport
export function formatSavedPromptsToNotes(report: SavedPromptsToNotesReport): string[] {
  const lines: string[] = [];
  for (const [key, count] of Object.entries(report.counts)) lines.push(`saved prompts → notes: ${count} note${count === 1 ? '' : 's'} under ${key}`);
  for (const backup of report.backups) lines.push(`backup ${backup}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

const savedPromptsPath = () => process.env.RAC_SAVED_PROMPTS_FILE ?? '.data/saved-prompts.json';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// the note title: the first non-blank line trimmed to the limit, else a numbered fallback for an
// attachment-only prompt
function noteTitle(prompt: ParsedPrompt, nextAttachmentOnly: () => number): string {
  const firstLine = prompt.text.split('\n').map(line => line.trim()).find(line => line.length > 0);
  return firstLine === undefined ? `Saved prompt · ${nextAttachmentOnly()}` : firstLine.slice(0, maxNoteTitleLength);
}

// parse the saved-prompts file leniently into keyed prompt lists; a non-object throws so the
// caller leaves the source file in place
function parseSavedPrompts(raw: string): Record<string, ParsedPrompt[]> {
  let parsed: unknown;
  // a SyntaxError echoes a fragment of the file (prompt text) — keep prompt contents out of the log
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('the saved-prompts file is not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the saved-prompts file is not an object');
  const stored: Record<string, ParsedPrompt[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    stored[key] = value.flatMap(item => {
      if (item === null || typeof item !== 'object') return [];
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string') return [];
      const rawAttachments = (item as { attachments?: unknown }).attachments;
      const attachments = Array.isArray(rawAttachments)
        ? rawAttachments.flatMap(attachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' ? [(attachment as { name: string }).name] : [])
        : [];
      return [{ text, attachments }];
    });
  }
  return stored;
}

// move the source file to a sibling backup, never overwriting one (the older backup wins), so a
// second boot finds no source file and does nothing
async function moveToBackup(file: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const destination = `${file}.migrated-to-notes.bak${attempt === 0 ? '' : `.${attempt}`}`;
    try {
      await link(file, destination);   // fails EEXIST rather than overwriting an existing backup
      await unlink(file);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}

/**
 * Carry every saved prompt keyed by a configured Project id into a Note under that id, then move
 * the source file aside so a second boot is a no-op. Runs after the config is acquired and before
 * the app builds. A saved-prompts key is a Worktree wire id `<projectId>:<realpath>` (or a stale
 * agent id for a scratch agent); its Note key is the embedded Project id, matching how the notes
 * store is keyed. Records under a key whose project is not configured are skipped and named.
 * Over-limit records are counted, not fatal; a read/parse/move failure leaves the source file in
 * place and is reported, since Saved prompts have no UI to fall back to.
 */
export async function migrateSavedPromptsToNotes(options: { projectIds: Iterable<string>; notes: WorktreeNoteService; savedPromptsFile?: string }): Promise<SavedPromptsToNotesReport> {
  const file = options.savedPromptsFile ?? savedPromptsPath();
  const projectIds = new Set(options.projectIds);
  const report: SavedPromptsToNotesReport = { counts: {}, backups: [], warnings: [] };

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report;   // nothing to migrate
    report.warnings.push(`${message(error)}; the saved-prompts file was left in place`);
    return report;
  }

  // Parse, then move the source aside *before* writing any Notes. Moving first means a Note write
  // that fails partway cannot duplicate Notes on the next boot: the second boot finds no source
  // file and does nothing, and any un-migrated prompts remain in the backup. A parse or move
  // failure writes nothing and leaves the source in place.
  let stored: Record<string, ParsedPrompt[]>;
  try {
    stored = parseSavedPrompts(raw);
  } catch (error) {
    report.warnings.push(`${message(error)}; the saved-prompts file was left in place`);
    return report;
  }
  try {
    report.backups.push(await moveToBackup(file));
  } catch (error) {
    report.warnings.push(`${message(error)}; the saved-prompts file was left in place`);
    return report;
  }

  // Write the Notes from the in-memory prompts; the source is already safe in the backup, so a
  // note-store error stops the migration without crashing boot and without a retry that duplicates.
  let dropped = 0;
  let attachmentOnly = 0;
  try {
    for (const [key, prompts] of Object.entries(stored)) {
      const projectId = projectIdOf(key);
      if (!projectIds.has(projectId)) {
        report.warnings.push(`key ${key} has no configured project; ${prompts.length} saved prompt${prompts.length === 1 ? '' : 's'} not migrated`);
        continue;
      }
      let created = 0;
      for (const prompt of prompts) {
        const title = noteTitle(prompt, () => (attachmentOnly += 1));
        const text = noteTextWithDroppedAttachments(prompt.text, prompt.attachments.map(name => ({ name })));
        if (await options.notes.createWithText(projectId, title, text) === undefined) dropped += 1;
        else created += 1;
      }
      if (created > 0) report.counts[projectId] = (report.counts[projectId] ?? 0) + created;
    }
  } catch (error) {
    report.warnings.push(`${message(error)}; migration stopped, the remaining saved prompts are preserved in the backup`);
    return report;
  }
  if (dropped > 0) report.warnings.push(`${dropped} saved prompt${dropped === 1 ? '' : 's'} exceeded the notes limits and ${dropped === 1 ? 'was' : 'were'} not migrated`);
  return report;
}
