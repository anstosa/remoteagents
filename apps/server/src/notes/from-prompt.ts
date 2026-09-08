// A prompt's text carried into a Note: Notes do not keep attachments, so any attachment names
// are listed at the end. Blank text yields just the list, so an attachment-only prompt still
// names its files. Shared by the queued/undelivered drain and the saved-prompts boot migration.
export function noteTextWithDroppedAttachments(text: string, attachments: Array<{ name: string }> = []): string {
  const names = attachments.map(attachment => attachment.name).filter(name => name.length > 0);
  if (names.length === 0) return text;
  return `${text}${text.trim().length === 0 ? '' : '\n\n'}Dropped attachments: ${names.join(', ')}`;
}

// Compose a Note from a queued or undelivered prompt. The title carries the host-local HH:MM the
// prompt was saved or drained, matching the "Queued prompt · HH:MM" / "Undelivered prompt · HH:MM"
// copy in the spec.
export function promptNoteContent(prefix: 'Queued prompt' | 'Undelivered prompt', at: Date, prompt: { text: string; attachments?: Array<{ name: string }> }): { title: string; text: string } {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return { title: `${prefix} · ${time}`, text: noteTextWithDroppedAttachments(prompt.text, prompt.attachments) };
}
