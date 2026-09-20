import { maxNoteTitleLength } from './service.js';

// A prompt's text carried into a Note: Notes do not keep attachments, so any attachment names
// are listed at the end. Blank text yields just the list, so an attachment-only prompt still
// names its files. Shared by the queued/undelivered drain and the saved-prompts boot migration.
export function noteTextWithDroppedAttachments(text: string, attachments: Array<{ name: string }> = []): string {
  const names = attachments.map(attachment => attachment.name).filter(name => name.length > 0);
  if (names.length === 0) return text;
  return `${text}${text.trim().length === 0 ? '' : '\n\n'}Dropped attachments: ${names.join(', ')}`;
}

// compose queued prompt note content with a bounded host-local title
export function promptNoteContent(worktreeName: string, at: Date, prompt: { text: string; attachments?: Array<{ name: string }> }): { title: string; text: string } {
  const hours = at.getHours();
  const time = `${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  const prefix = 'Queued prompt in ';
  const suffix = ` · ${time}`;
  const fallbackName = worktreeName.trim() || 'workspace';
  const boundedName = fallbackName.slice(0, maxNoteTitleLength - prefix.length - suffix.length);
  return { title: `${prefix}${boundedName}${suffix}`, text: noteTextWithDroppedAttachments(prompt.text, prompt.attachments) };
}
