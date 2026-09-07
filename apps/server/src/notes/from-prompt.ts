// Compose a Note from a queued or undelivered prompt. Notes do not keep attachments, so any
// attachment names are listed at the end of the text; the title carries the host-local HH:MM the
// prompt was saved or drained, matching the "Queued prompt · HH:MM" / "Undelivered prompt · HH:MM"
// copy in the spec.
export function promptNoteContent(prefix: 'Queued prompt' | 'Undelivered prompt', at: Date, prompt: { text: string; attachments?: Array<{ name: string }> }): { title: string; text: string } {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const names = (prompt.attachments ?? []).map(attachment => attachment.name).filter(name => name.length > 0);
  const dropped = names.length === 0 ? '' : `${prompt.text.trim().length === 0 ? '' : '\n\n'}Dropped attachments: ${names.join(', ')}`;
  return { title: `${prefix} · ${time}`, text: `${prompt.text}${dropped}` };
}
