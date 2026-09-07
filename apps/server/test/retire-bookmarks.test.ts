import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireBookmarks } from '../src/conversations/retire-bookmarks.js';

// the retired bookmarks file is never read back; its absence is what makes the log fire once
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false);

describe('boot bookmark retirement', () => {
  let directory: string;
  let file: string;
  let env: NodeJS.ProcessEnv;
  const lines: string[] = [];
  const log = (message: string) => { lines.push(message); };
  // just the per-bookmark lines, trimmed of the trailing newline for exact matching
  const bookmarkLines = () => lines.filter(line => line.startsWith('  bookmark ')).map(line => line.replace(/\n$/u, ''));

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rac-retire-bookmarks-'));
    file = join(directory, 'bookmarks.json');
    env = { RAC_BOOKMARKS_FILE: file };
    lines.length = 0;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('logs each bookmark once across every group and sets the file aside', async () => {
    const stored = {
      remoteagents: [
        { id: 'aaaaaaaaaaaa', threadId: '0198c444-4444-7444-8444-444444444444', title: 'Ship the console', createdAt: '2026-08-20T20:00:00.000Z' },
        { id: 'bbbbbbbbbbbb', threadId: '0198c555-5555-7555-8555-555555555555', title: 'Claude naming', createdAt: '2026-08-21T20:00:00.000Z', kind: 'claude' },
      ],
      // a second save-key group proves the retirement iterates every Project, not just the first
      potato: [
        { id: 'cccccccccccc', threadId: '0198c666-6666-7666-8666-666666666666', title: 'Second project chat', createdAt: '2026-08-22T20:00:00.000Z' },
      ],
    };
    await writeFile(file, JSON.stringify(stored));

    await retireBookmarks(env, log);

    // exactly one structured line per bookmark: kind (absent → codex), Conversation id, title
    expect(bookmarkLines()).toEqual([
      '  bookmark codex 0198c444-4444-7444-8444-444444444444 Ship the console',
      '  bookmark claude 0198c555-5555-7555-8555-555555555555 Claude naming',
      '  bookmark codex 0198c666-6666-7666-8666-666666666666 Second project chat',
    ]);
    // the original file is set aside verbatim, never deleted
    expect(await exists(file)).toBe(false);
    expect(JSON.parse(await readFile(`${file}.retired`, 'utf8'))).toEqual(stored);
  });

  it('strips control characters and clamps a hand-edited title so it stays one line', async () => {
    // an OSC terminal escape (ESC ] 0 ; ... BEL) and an embedded newline that would otherwise
    // inject into the boot log if written verbatim
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const title = `${esc}]0;pwned${bel} and\nnewline ${'x'.repeat(200)}`;
    await writeFile(file, JSON.stringify({ remoteagents: [{ id: 'aaaaaaaaaaaa', threadId: '0198c444-4444-7444-8444-444444444444', title, createdAt: '2026-08-20T20:00:00.000Z' }] }));

    await retireBookmarks(env, log);

    // one line only, no escape or embedded newline leaked, clamped to the field bound
    expect(bookmarkLines()).toHaveLength(1);
    const logged = bookmarkLines()[0]!;
    expect(logged).not.toContain(esc);
    expect(logged).not.toContain(bel);
    expect(logged).not.toContain('\n');
    expect(logged.length).toBeLessThanOrEqual('  bookmark codex 0198c444-4444-7444-8444-444444444444 '.length + 120);
  });

  it('is silent and idempotent on a second boot: the retired file is never read', async () => {
    await writeFile(file, JSON.stringify({ remoteagents: [{ id: 'aaaaaaaaaaaa', threadId: '0198c444-4444-7444-8444-444444444444', title: 'Ship it', createdAt: '2026-08-20T20:00:00.000Z' }] }));
    await retireBookmarks(env, log);
    lines.length = 0;

    await retireBookmarks(env, log);

    expect(lines).toEqual([]);
    expect(await exists(`${file}.retired`)).toBe(true);
  });

  it('is a silent no-op when no bookmarks file exists', async () => {
    await retireBookmarks(env, log);

    expect(lines).toEqual([]);
    expect(await exists(file)).toBe(false);
    expect(await exists(`${file}.retired`)).toBe(false);
  });

  it('sets a malformed file aside with a warning rather than blocking boot', async () => {
    await writeFile(file, 'not json at all');

    await retireBookmarks(env, log);

    expect(lines.join('')).toMatch(/is not valid JSON/i);
    expect(await exists(file)).toBe(false);
    expect(await readFile(`${file}.retired`, 'utf8')).toBe('not json at all');
  });

  it('sets a wrong-shape (array) file aside with a warning', async () => {
    await writeFile(file, '[]');

    await retireBookmarks(env, log);

    expect(lines.join('')).toMatch(/is not a bookmarks object/i);
    expect(bookmarkLines()).toEqual([]);
    expect(await exists(file)).toBe(false);
    expect(await readFile(`${file}.retired`, 'utf8')).toBe('[]');
  });

  it('warns and continues boot when the bookmarks file cannot be read', async () => {
    // a directory at the bookmarks path cannot be read (EISDIR), standing in for an EACCES file
    await mkdir(file);

    await expect(retireBookmarks(env, log)).resolves.toBeUndefined();

    expect(lines.join('')).toMatch(/could not read/i);
    // nothing was set aside; boot continued
    expect(await exists(`${file}.retired`)).toBe(false);
  });

  it('warns and leaves the file in place when it cannot be set aside, logging nothing', async () => {
    await writeFile(file, JSON.stringify({ remoteagents: [{ id: 'aaaaaaaaaaaa', threadId: '0198c444-4444-7444-8444-444444444444', title: 'Ship it', createdAt: '2026-08-20T20:00:00.000Z' }] }));
    // a directory already at the rename target makes `rename` fail
    await mkdir(`${file}.retired`);

    await expect(retireBookmarks(env, log)).resolves.toBeUndefined();

    expect(lines.join('')).toMatch(/could not set .* aside/i);
    // the bookmarks are NOT logged (only a successful set-aside logs them, so a later boot retries)
    expect(bookmarkLines()).toEqual([]);
    expect(await exists(file)).toBe(true);
  });
});
