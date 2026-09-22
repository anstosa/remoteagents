import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { promptNoteContent } from '../src/notes/from-prompt.js';

describe('promptNoteContent', () => {
  const at = new Date(2026, 8, 7, 9, 5); // host-local 09:05

  it('titles the note with the worktree and host-local 12-hour time', () => {
    expect(promptNoteContent('Renamed Cora', at, { text: 'Summarize the branch.' }))
      .toEqual({ title: 'Queued prompt in Renamed Cora · 9:05 AM', text: 'Summarize the branch.' });
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 13, 5), { text: 'Afternoon prompt.' }).title)
      .toBe('Queued prompt in Renamed Cora · 1:05 PM');
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 12, 5), { text: 'Noon prompt.' }).title)
      .toBe('Queued prompt in Renamed Cora · 12:05 PM');
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 0, 5), { text: 'Midnight prompt.' }).title)
      .toBe('Queued prompt in Renamed Cora · 12:05 AM');
  });

  // exercise the real process timezone independently of the test worker's zone
  it.each([
    ['UTC', '2026-09-22T15:05:00Z', '3:05 PM'],
    ['America/Los_Angeles', '2026-09-22T15:05:00Z', '8:05 AM'],
    ['America/Los_Angeles', '2026-01-22T15:05:00Z', '7:05 AM'],
    ['Asia/Tokyo', '2026-09-22T15:05:00Z', '12:05 AM']
  ])('formats %s server-local time for %s', (timeZone, instant, expected) => {
    const script = `import { promptNoteContent } from './src/notes/from-prompt.ts';
      console.log(promptNoteContent('workspace', new Date(process.argv[1]), { text: 'Queued prompt' }).title);`;
    const title = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, instant], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, TZ: timeZone },
      encoding: 'utf8'
    }).trim();
    expect(title).toBe(`Queued prompt in workspace · ${expected}`);
  });

  it('lists dropped attachment names after the text', () => {
    expect(promptNoteContent('cora', at, { text: 'Review this.', attachments: [{ name: 'context.txt' }, { name: 'diff.patch' }] }))
      .toEqual({ title: 'Queued prompt in cora · 9:05 AM', text: 'Review this.\n\nDropped attachments: context.txt, diff.patch' });
  });

  it('drops the leading gap when an attachment-only prompt has no text', () => {
    expect(promptNoteContent('scratch', at, { text: '', attachments: [{ name: 'shot.png' }] }))
      .toEqual({ title: 'Queued prompt in scratch · 9:05 AM', text: 'Dropped attachments: shot.png' });
  });

  it('bounds long worktree labels to the note title cap', () => {
    const content = promptNoteContent('x'.repeat(200), at, { text: 'Keep this.' });
    expect(content.title).toHaveLength(120);
    expect(content.title).toMatch(/^Queued prompt in x+ · 9:05 AM$/u);
  });
});
