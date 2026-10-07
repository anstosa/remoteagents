import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendHostFileFavorites, HostFileFavoritesStore, sameFavoriteObject } from '../src/host-files/favorites.js';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import type { FavoriteRecord, HostFileIdentity, HostFilesBackend } from '../src/host-files/contracts.js';

const roots: string[] = [];
const identity = (ino: string, ctimeNs = '3'): HostFileIdentity => ({ dev: '1', ino, ctimeNs, mtimeNs: ctimeNs, size: '5', nlink: '1', kind: 'file' });

// create one valid persisted favorite record
function favorite(index: number, path: string): FavoriteRecord {
  const timestamp = '2026-10-06T20:00:00.000Z';
  return { id: `favorite_${String(index).padStart(12, '0')}`, path, identity: identity(String(index + 2)), createdAt: timestamp, updatedAt: timestamp };
}

afterEach(async () => {
  // remove only disposable favorites fixtures
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// create one isolated durable store
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rac-file-favorites-'));
  roots.push(root);
  const file = join(root, 'favorites.json');
  return { file, store: new HostFileFavoritesStore(file, () => Date.parse('2026-10-06T20:00:00.000Z')) };
}

describe('host Files favorite storage', () => {
  // persist mode-0600 records and isolate exact Place ids across restarts
  it('persists idempotently with exact Place isolation', async () => {
    const f = await fixture();
    const first = await f.store.add('project:/one', '/tmp/file', identity('2'));
    const repeated = await f.store.add('project:/one', '/tmp/file', identity('2'));
    await f.store.add('project:/two', '/tmp/file', identity('2'));
    expect(repeated.id).toBe(first.id);
    expect(await f.store.list('project:/one')).toHaveLength(1);
    expect(await f.store.list('project:/two')).toHaveLength(1);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const restarted = new HostFileFavoritesStore(f.file);
    expect((await restarted.list('project:/one'))[0]?.path).toBe('/tmp/file');
  });

  // require explicit acknowledgement after path replacement but allow same-inode edits
  it('distinguishes modified and replaced objects', async () => {
    const f = await fixture();
    const favorite = await f.store.add('project:/one', '/tmp/file', identity('2'));
    expect(sameFavoriteObject(favorite.identity, identity('2', '9'))).toBe(true);
    await expect(f.store.add('project:/one', '/tmp/file', identity('7'))).rejects.toMatchObject({ code: 'favorite_replaced' });
    const acknowledged = await f.store.acknowledge('project:/one', favorite.id, '/tmp/file', identity('7'));
    expect(acknowledged.identity.ino).toBe('7');
  });

  // serialize concurrent mutations without dropping either record
  it('serializes concurrent adds and exact rewrites', async () => {
    const f = await fixture();
    const backend = createHostFilesEngine('favorite-owner-generation', { favoritesFile: f.file, journalFile: `${f.file}.journal` });
    const firstAdapter = new BackendHostFileFavorites(backend);
    const secondAdapter = new BackendHostFileFavorites(backend);
    const [one, two] = await Promise.all([
      firstAdapter.add('project:/one', '/tmp/one', identity('2')),
      secondAdapter.add('project:/one', '/tmp/two', identity('3')),
    ]);
    await firstAdapter.rewrite([
      { placeId: 'project:/one', favoriteId: one.id, path: '/srv/one', identity: identity('4') },
      { placeId: 'project:/one', favoriteId: two.id, path: '/srv/two', identity: identity('5'), freshness: { operationId: 'operation_123456789', state: 'pending-final-ctime' } },
    ]);
    expect((await secondAdapter.list('project:/one')).map(record => [record.path, record.freshness?.state])).toEqual([['/srv/one', undefined], ['/srv/two', 'pending-final-ctime']]);
    expect((await secondAdapter.beneath('/srv')).map(match => match.favorite.path)).toEqual(['/srv/one', '/srv/two']);
    expect((await firstAdapter.acknowledge('project:/one', one.id, '/srv/one', identity('6'))).identity.ino).toBe('6');
    expect(await secondAdapter.remove('project:/one', two.id)).toBe(true);
    expect(await firstAdapter.list('project:/one')).toHaveLength(1);
    await backend.close();
  });

  // reject corrupt versions and prototype-bearing Place keys
  it('fails closed on invalid persisted data', async () => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ version: 2, places: {} }), { mode: 0o600 });
    await expect(f.store.list('project:/one')).rejects.toThrow('invalid file favorites file');
    await writeFile(f.file, '{"version":1,"places":{"__proto__":[]}}', { mode: 0o600 });
    await expect(f.store.list('project:/one')).rejects.toThrow('invalid file favorites file');
    expect(await readFile(f.file, 'utf8')).toContain('__proto__');
  });

  // bound repeated Place metadata before a subtree result reaches the broker
  it('rejects an oversized repeated-Place subtree result', async () => {
    const f = await fixture();
    const placeId = 'p'.repeat(4096);
    const records = Array.from({ length: 800 }, (_, index) => favorite(index, `/tmp/root/${index}`));
    await writeFile(f.file, JSON.stringify({ version: 1, places: { [placeId]: records } }), { mode: 0o600 });
    await expect(f.store.beneath('/tmp/root')).rejects.toMatchObject({ code: 'limit_exceeded', statusCode: 413 });
  });

  // bound one large Place list independently from the persisted file limit
  it('rejects an oversized favorite list result', async () => {
    const f = await fixture();
    const records = Array.from({ length: 1_000 }, (_, index) => favorite(index, `/tmp/${index}-${'x'.repeat(3_300)}`));
    await writeFile(f.file, JSON.stringify({ version: 1, places: { place: records } }), { mode: 0o600 });
    await expect(f.store.list('place')).rejects.toMatchObject({ code: 'limit_exceeded', statusCode: 413 });
  });

  // reject an expanded rewrite command before invoking its backend owner
  it('rejects oversized backend rewrites before dispatch', async () => {
    const request = vi.fn();
    const backend = { generation: () => 'generation', request } as unknown as HostFilesBackend;
    const adapter = new BackendHostFileFavorites(backend);
    const placeId = 'p'.repeat(4096);
    const rewrites = Array.from({ length: 800 }, (_, index) => ({ placeId, favoriteId: `favorite_${String(index).padStart(12, '0')}`, path: `/target/${index}`, identity: identity(String(index + 2)) }));
    await expect(adapter.rewrite(rewrites)).rejects.toMatchObject({ code: 'limit_exceeded', statusCode: 413 });
    expect(request).not.toHaveBeenCalled();
  });
});
