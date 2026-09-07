import { describe, expect, it } from 'vitest';
import { promptNoteContent } from '../src/notes/from-prompt.js';

describe('promptNoteContent', () => {
  const at = new Date(2026, 8, 7, 9, 5); // host-local 09:05

  it('titles the note with the prefix and host-local HH:MM and keeps the text', () => {
    expect(promptNoteContent('Queued prompt', at, { text: 'Summarize the branch.' }))
      .toEqual({ title: 'Queued prompt · 09:05', text: 'Summarize the branch.' });
  });

  it('lists dropped attachment names after the text', () => {
    expect(promptNoteContent('Undelivered prompt', at, { text: 'Review this.', attachments: [{ name: 'context.txt' }, { name: 'diff.patch' }] }))
      .toEqual({ title: 'Undelivered prompt · 09:05', text: 'Review this.\n\nDropped attachments: context.txt, diff.patch' });
  });

  it('drops the leading gap when an attachment-only prompt has no text', () => {
    expect(promptNoteContent('Undelivered prompt', at, { text: '', attachments: [{ name: 'shot.png' }] }))
      .toEqual({ title: 'Undelivered prompt · 09:05', text: 'Dropped attachments: shot.png' });
  });
});
