import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcessUses, ProcessUseFiles } from '../src/worktree-commands/process-uses.js';
import { maxReportFileBytes } from '../src/worktree-commands/process-reports.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scratch = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-uses-'))); roots.push(root); return root; };
const use = (worktree: string, process: string) => ({ worktree, process });

describe('parsing a Stack process uses file', () => {
  it('reads each process used, as a checkout and a process name', () => {
    const text = JSON.stringify([use('/code/static', 'static'), use('/code/obsidian', 'api')]);
    expect(parseProcessUses(text)).toEqual([use('/code/static', 'static'), use('/code/obsidian', 'api')]);
  });

  it('reads an empty array as nothing used', () => {
    expect(parseProcessUses('[]')).toEqual([]);
  });

  it('drops fields it does not know', () => {
    expect(parseProcessUses(JSON.stringify([{ ...use('/code/static', 'static'), port: 4000 }]))).toEqual([use('/code/static', 'static')]);
  });

  it.each([
    ['not JSON', '[{"worktree": "/code'],
    ['not an array', JSON.stringify(use('/code/static', 'static'))],
    ['an entry without a process', JSON.stringify([{ worktree: '/code/static' }])],
    ['an entry without a worktree', JSON.stringify([{ process: 'static' }])],
    ['an empty process', JSON.stringify([use('/code/static', '')])],
    ['a relative worktree', JSON.stringify([use('code/static', 'static')])],
    ['a process that is not text', JSON.stringify([{ worktree: '/code/static', process: 7 }])],
    ['a process no config could name', JSON.stringify([use('/code/static', 'static site')])],
    ['a process name over 40 characters', JSON.stringify([use('/code/static', 'x'.repeat(41))])],
    ['a worktree path over 4096 characters', JSON.stringify([use(`/${'x'.repeat(4096)}`, 'static')])]
  ])('ignores the whole file for %s', (_case, text) => {
    expect(parseProcessUses(text)).toEqual({ invalid: expect.any(String) });
  });

  it('says why a file is ignored without repeating what it holds', () => {
    const parsed = parseProcessUses(JSON.stringify([{ worktree: 'SECRET_TOKEN', process: 'static' }]));
    expect(parsed).toEqual({ invalid: expect.any(String) });
    expect(JSON.stringify(parsed)).not.toContain('SECRET_TOKEN');
  });

  it('reads only the first 20 entries, and never looks at the rest', () => {
    const entries: unknown[] = Array.from({ length: 20 }, (_, index) => use('/code/static', `p${index}`));
    entries.push(use('/code/static', 'the-21st'), { worktree: 'broken' });
    const parsed = parseProcessUses(JSON.stringify(entries));
    expect(Array.isArray(parsed) && parsed.map(entry => entry.process)).toEqual(Array.from({ length: 20 }, (_, index) => `p${index}`));
  });
});

describe('reading a Stack process uses file', () => {
  const reader = () => {
    const ignored: string[] = [];
    const files = new ProcessUseFiles();
    return { ignored, read: (file: string) => files.read(file, reason => ignored.push(reason)) };
  };

  it('reads nothing from a file that is not there', async () => {
    const { read, ignored } = reader();
    await expect(read(join(await scratch(), 'api.uses.json'))).resolves.toEqual([]);
    expect(ignored).toEqual([]);
  });

  it("resolves each entry's worktree by realpath, keeping a path it cannot resolve", async () => {
    const root = await scratch();
    await mkdir(join(root, 'static'));
    await symlink(join(root, 'static'), join(root, 'static-link'));
    const file = join(root, 'api.uses.json');
    await writeFile(file, JSON.stringify([use(join(root, 'static-link'), 'static'), use('/host/only/../only/static/', 'static')]));
    await expect(reader().read(file)).resolves.toEqual([use(join(root, 'static'), 'static'), use('/host/only/static', 'static')]);
  });

  it('ignores a file over 64 KB, or behind a symlink, whole', async () => {
    const root = await scratch();
    const big = join(root, 'big.uses.json');
    await writeFile(big, JSON.stringify([use('/code/static', 'static')]).replace('[', `[${' '.repeat(maxReportFileBytes)}`));
    const target = join(root, 'elsewhere.json');
    await writeFile(target, JSON.stringify([use('/code/static', 'static')]));
    await symlink(target, join(root, 'link.uses.json'));
    const { read, ignored } = reader();

    await expect(read(big)).resolves.toEqual([]);
    await expect(read(join(root, 'link.uses.json'))).resolves.toEqual([]);
    expect(ignored).toEqual([expect.stringContaining('64 KB'), expect.any(String)]);
  });
});
