import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxNoticeFileBytes, parseProcessNotices, ProcessNoticeFiles } from '../src/worktree-commands/process-notices.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scratch = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-notices-'))); roots.push(root); return root; };
const notice = (message: string, extra: Record<string, unknown> = {}) => ({ message, ...extra });

describe('parsing a Process notices file', () => {
  it('reads each notice, defaulting its level to warning', () => {
    const text = JSON.stringify([
      { level: 'info', message: 'warming the cache' },
      { message: 'static is not running', worktree: '/code/static', process: 'static' },
      { message: 'look at the other checkout', worktree: '/code/other' }
    ]);
    expect(parseProcessNotices(text)).toEqual([
      { level: 'info', message: 'warming the cache' },
      { level: 'warning', message: 'static is not running', worktree: '/code/static', process: 'static' },
      { level: 'warning', message: 'look at the other checkout', worktree: '/code/other' }
    ]);
  });

  it('reads an empty array as no notices', () => {
    expect(parseProcessNotices('[]')).toEqual([]);
  });

  it.each([
    ['not JSON', '[{"message": "half written'],
    ['not an array', JSON.stringify({ message: 'one' })],
    ['an unknown level', JSON.stringify([notice('a'), notice('b', { level: 'error' })])],
    ['a message over 500 characters', JSON.stringify([notice('x'.repeat(501))])],
    ['an empty message', JSON.stringify([notice('')])],
    ['a message that is not text', JSON.stringify([{ message: 42 }])],
    ['a relative worktree', JSON.stringify([notice('a', { worktree: 'code/static' })])],
    ['a process without a worktree', JSON.stringify([notice('a', { process: 'static' })])]
  ])('ignores the whole file for %s', (_case, text) => {
    const parsed = parseProcessNotices(text);
    expect(parsed).toEqual({ invalid: expect.any(String) });
  });

  // why goes to the console's log, which the file's writer must not be able to write into
  it('says why a file is ignored without repeating what it holds', () => {
    for (const text of ['SECRET_TOKEN is not JSON', JSON.stringify([{ level: 'SECRET_TOKEN\n[auth] forged', message: 'a' }]), JSON.stringify([{ message: 'SECRET_TOKEN'.repeat(50) }])]) {
      const parsed = parseProcessNotices(text);
      expect(parsed).toEqual({ invalid: expect.any(String) });
      expect(JSON.stringify(parsed)).not.toContain('SECRET_TOKEN');
    }
  });

  it('accepts a message of exactly 500 characters', () => {
    expect(parseProcessNotices(JSON.stringify([notice('x'.repeat(500))]))).toEqual([{ level: 'warning', message: 'x'.repeat(500) }]);
  });

  it('reads only the first 20 notices, and never looks at the rest', () => {
    const entries: unknown[] = Array.from({ length: 20 }, (_, index) => notice(`notice ${index}`));
    entries.push(notice('the 21st'), { level: 'broken' });
    const parsed = parseProcessNotices(JSON.stringify(entries));
    expect(Array.isArray(parsed) && parsed.map(entry => entry.message)).toEqual(Array.from({ length: 20 }, (_, index) => `notice ${index}`));
  });
});

describe('reading a Process notices file', () => {
  const reader = () => {
    const ignored: string[] = [];
    const files = new ProcessNoticeFiles();
    return { ignored, read: (file: string) => files.read(file, reason => ignored.push(reason)) };
  };

  it('reads nothing from a file that is not there', async () => {
    const { read, ignored } = reader();
    await expect(read(join(await scratch(), 'dev.notices.json'))).resolves.toEqual([]);
    expect(ignored).toEqual([]);
  });

  it('rereads the file only when its mtime changes', async () => {
    const file = join(await scratch(), 'dev.notices.json');
    const mtime = new Date('2026-09-27T08:00:00Z');
    await writeFile(file, JSON.stringify([notice('first')]));
    await utimes(file, mtime, mtime);
    const { read } = reader();
    await expect(read(file)).resolves.toEqual([{ level: 'warning', message: 'first' }]);

    // the same mtime is the same file, whatever it now holds
    await writeFile(file, JSON.stringify([notice('other')]));
    await utimes(file, mtime, mtime);
    await expect(read(file)).resolves.toEqual([{ level: 'warning', message: 'first' }]);

    await utimes(file, mtime, new Date(mtime.getTime() + 5_000));
    await expect(read(file)).resolves.toEqual([{ level: 'warning', message: 'other' }]);
  });

  it('ignores a malformed file whole, and says so once per change', async () => {
    const file = join(await scratch(), 'dev.notices.json');
    await writeFile(file, '[{"message": "half');
    const { read, ignored } = reader();
    // two readers at once, as a dashboard build and an integration's request can be, share one read
    await expect(Promise.all([read(file), read(file)])).resolves.toEqual([[], []]);
    await expect(read(file)).resolves.toEqual([]);
    expect(ignored).toHaveLength(1);

    const { mtime } = await stat(file);
    await utimes(file, mtime, new Date(mtime.getTime() + 5_000));
    await expect(read(file)).resolves.toEqual([]);
    expect(ignored).toHaveLength(2);
  });

  it('ignores a file over 64 KB whole', async () => {
    const file = join(await scratch(), 'dev.notices.json');
    const padded = JSON.stringify([notice('big')]).replace('[', `[${' '.repeat(maxNoticeFileBytes)}`);
    await writeFile(file, padded);
    const { read, ignored } = reader();
    await expect(read(file)).resolves.toEqual([]);
    expect(ignored).toEqual([expect.stringContaining('64 KB')]);
  });

  it('reads a file of exactly 64 KB', async () => {
    const file = join(await scratch(), 'dev.notices.json');
    const text = JSON.stringify([notice('fits')]);
    await writeFile(file, `${' '.repeat(maxNoticeFileBytes - text.length)}${text}`);
    await expect(reader().read(file)).resolves.toEqual([{ level: 'warning', message: 'fits' }]);
  });

  it('never follows a symlink put where the file goes, nor reads a FIFO or a directory', async () => {
    const root = await scratch();
    const target = join(root, 'elsewhere.json');
    await writeFile(target, JSON.stringify([notice('from elsewhere')]));
    await symlink(target, join(root, 'link.notices.json'));
    execFileSync('/usr/bin/mkfifo', [join(root, 'fifo.notices.json')]);
    await mkdir(join(root, 'dir.notices.json'));
    const { read, ignored } = reader();

    for (const name of ['link', 'fifo', 'dir']) await expect(read(join(root, `${name}.notices.json`))).resolves.toEqual([]);
    expect(ignored).toHaveLength(3);
    // each is one change, however what the symlink points at changes
    await writeFile(target, JSON.stringify([notice('changed elsewhere')]));
    for (const name of ['link', 'fifo', 'dir']) await read(join(root, `${name}.notices.json`));
    expect(ignored).toHaveLength(3);
  });

  // a notice names a checkout as the reporting process sees it; the console matches Worktrees by
  // their realpath, so a symlinked path is resolved, and one the console cannot see is kept as written
  it("resolves a notice's worktree by realpath, keeping a path it cannot resolve", async () => {
    const root = await scratch();
    await mkdir(join(root, 'static'));
    await symlink(join(root, 'static'), join(root, 'static-link'));
    const file = join(root, 'dev.notices.json');
    await writeFile(file, JSON.stringify([notice('linked', { worktree: join(root, 'static-link'), process: 'static' }), notice('host only', { worktree: '/host/only/../only/static/' })]));
    await expect(reader().read(file)).resolves.toEqual([
      { level: 'warning', message: 'linked', worktree: join(root, 'static'), process: 'static' },
      { level: 'warning', message: 'host only', worktree: '/host/only/static' }
    ]);
  });
});
