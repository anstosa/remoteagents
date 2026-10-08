import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeCache } from '../../src/adapters/file-change-cache.js';

const roots: string[] = [];
// remove only this test's files
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// create an isolated indexed file
async function fixture(value = 'first'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-file-cache-'));
  roots.push(root);
  const path = join(root, 'record');
  await writeFile(path, value);
  return path;
}

describe('file-change result cache', () => {
  // metadata checks replace unchanged content reads
  it('coalesces parallel reads and reuses unchanged derived results', async () => {
    const path = await fixture();
    const read = vi.fn(async (file: string) => (await readFile(file, 'utf8')).toUpperCase());
    const cache = new FileChangeCache(read);
    expect(await Promise.all([cache.get(path), cache.get(path), cache.get(path)])).toEqual(['FIRST', 'FIRST', 'FIRST']);
    expect(await cache.get(path)).toBe('FIRST');
    expect(read).toHaveBeenCalledOnce();
  });

  // a parsed empty result is still reusable
  it('retains undefined without confusing it with a cache miss', async () => {
    const path = await fixture();
    const read = vi.fn(async () => undefined);
    const cache = new FileChangeCache(read);
    await cache.get(path);
    await cache.get(path);
    expect(read).toHaveBeenCalledOnce();
  });

  // each mutation changes the fingerprint even when the old mtime is restored
  it('invalidates append, truncation, equal-size rewrite, replacement and deletion', async () => {
    const path = await fixture();
    const read = vi.fn((file: string) => readFile(file, 'utf8'));
    const cache = new FileChangeCache(read);
    expect(await cache.get(path)).toBe('first');
    await appendFile(path, '!');
    expect(await cache.get(path)).toBe('first!');
    await writeFile(path, 'short');
    expect(await cache.get(path)).toBe('short');
    const before = await stat(path);
    await writeFile(path, 'other');
    await utimes(path, before.atime, before.mtime);
    expect(await cache.get(path)).toBe('other');
    await writeFile(`${path}.new`, 'newer');
    await utimes(`${path}.new`, before.atime, before.mtime);
    await rename(`${path}.new`, path);
    expect(await cache.get(path)).toBe('newer');
    await rm(path);
    await expect(cache.get(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, 'again');
    expect(await cache.get(path)).toBe('again');
    expect(read).toHaveBeenCalledTimes(6);
  });

  // transient failures must not become durable empty results
  it('retries failed reads without a file change', async () => {
    const path = await fixture();
    const read = vi.fn().mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue('first');
    const cache = new FileChangeCache(read);
    await expect(cache.get(path)).rejects.toThrow('temporary read failure');
    expect(await cache.get(path)).toBe('first');
    expect(read).toHaveBeenCalledTimes(2);
  });

  // fingerprints follow the same symlink target as the content reader
  it('invalidates a symlink path when its target changes', async () => {
    const first = await fixture('first'); const second = await fixture('other');
    const link = `${first}.link`;
    await symlink(first, link);
    const read = vi.fn((file: string) => readFile(file, 'utf8'));
    const cache = new FileChangeCache(read);
    expect(await cache.get(link)).toBe('first');
    await symlink(second, `${link}.new`);
    await rename(`${link}.new`, link);
    expect(await cache.get(link)).toBe('other');
    expect(read).toHaveBeenCalledTimes(2);
  });

  // a delayed old read cannot publish content from before an append
  it('rejects unstable reads and retries the changed file', async () => {
    const path = await fixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const read = vi.fn(async (file: string) => {
      const value = await readFile(file, 'utf8');
      started();
      await gate;
      return value;
    });
    const cache = new FileChangeCache(read);
    const pending = cache.get(path);
    const rejected = expect(pending).rejects.toThrow('changed while reading');
    await ready;
    await appendFile(path, '!');
    release();
    await rejected;
    expect(await cache.get(path)).toBe('first!');
    expect(read).toHaveBeenCalledTimes(2);
  });

  // least-recently-used entries leave before active readers
  it('bounds retained entries and refreshes recency on hits', async () => {
    const a = await fixture('a'); const b = await fixture('b'); const c = await fixture('c');
    const read = vi.fn((file: string) => readFile(file, 'utf8'));
    const cache = new FileChangeCache(read, { maxEntries: 2 });
    await cache.get(a); await cache.get(b); await cache.get(a); await cache.get(c); await cache.get(a);
    expect(read).toHaveBeenCalledTimes(3);
    await cache.get(b);
    expect(read).toHaveBeenCalledTimes(4);
  });

  // byte bounds include large parsed strings rather than just the key count
  it('evicts by retained bytes and does not retain an oversized result', async () => {
    const a = await fixture('12345'); const b = await fixture('67890'); const large = await fixture('x'.repeat(20));
    const read = vi.fn((file: string) => readFile(file, 'utf8'));
    const cache = new FileChangeCache(read, { maxBytes: 8, sizeOf: value => value.length });
    await cache.get(a); await cache.get(b); await cache.get(b);
    expect(read).toHaveBeenCalledTimes(2);
    await cache.get(a);
    expect(read).toHaveBeenCalledTimes(3);
    await cache.get(large); await cache.get(large);
    expect(read).toHaveBeenCalledTimes(5);
  });
});
