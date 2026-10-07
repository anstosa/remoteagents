import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HostFilesError, isHostFileIdentity, isHostFilesPath, type FavoriteRecord, type HostFileIdentity, type HostFilesBackend, type HostFilesFavoriteMatch, type HostFilesFavoriteRewrite } from './contracts.js';

type StoredFavorites = { version: 1; places: Record<string, FavoriteRecord[]> };
export type FavoriteRewrite = HostFilesFavoriteRewrite;

const maxPlaces = 2_000;
const maxPerPlace = 1_000;
const maxTotal = 20_000;
const maxFileBytes = 8 * 1024 * 1024;
const maxControlMetadataBytes = 3 * 1024 * 1024;

// count one array element plus its separator
function controlArrayItemBytes(value: unknown, index: number): number {
  return Buffer.byteLength(JSON.stringify(value)) + (index === 0 ? 0 : 1);
}

// bound one JSON array before it reaches the broker control channel
function requireBoundedControlArray(values: readonly unknown[], baseBytes = 2): void {
  let bytes = baseBytes;
  // count every repeated key and record exactly as serialized
  for (let index = 0; index < values.length; index += 1) {
    bytes += controlArrayItemBytes(values[index], index);
    // fail with one stable application error before transport encoding
    if (bytes > maxControlMetadataBytes) throw new HostFilesError('limit_exceeded', 'favorite metadata exceeds transfer limits', 413);
  }
}

// validate one bounded persisted identifier
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
}

// validate one persisted timestamp
function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// reject object-prototype keys from the persisted Place map
function validPlaceId(value: string): boolean {
  return value.length >= 1 && value.length <= 4096 && !/[\0\n\r]/u.test(value) && value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

// validate one favorite record without accepting unknown versions
function validFavorite(value: unknown): value is FavoriteRecord {
  // require one plain record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const freshness = record.freshness;
  const validFreshness = freshness === undefined || freshness !== null && typeof freshness === 'object' && !Array.isArray(freshness)
    && validId((freshness as Record<string, unknown>).operationId) && (freshness as Record<string, unknown>).state === 'pending-final-ctime';
  return validId(record.id) && isHostFilesPath(record.path) && isHostFileIdentity(record.identity)
    && validDate(record.createdAt) && validDate(record.updatedAt) && validFreshness;
}

// compare the stable object identity that distinguishes replacement from modification
export function sameFavoriteObject(left: HostFileIdentity, right: HostFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

export interface HostFileFavorites {
  // list one Place's favorites
  list(placeId: string): Promise<FavoriteRecord[]>;
  // add one exact favorite
  add(placeId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord>;
  // acknowledge one replaced favorite
  acknowledge(placeId: string, favoriteId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord>;
  // remove one favorite
  remove(placeId: string, favoriteId: string): Promise<boolean>;
  // atomically rewrite moved favorites
  rewrite(rewrites: readonly FavoriteRewrite[]): Promise<void>;
  // find favorites beneath one path
  beneath(path: string): Promise<HostFilesFavoriteMatch[]>;
}

export class HostFileFavoritesStore implements HostFileFavorites {
  private mutation = Promise.resolve();

  // select one portable persisted file and clock
  constructor(private readonly file = process.env.RAC_FILE_FAVORITES_FILE ?? '.data/file-favorites.json', private readonly now: () => number = Date.now) {}

  // list one exact Place's favorites
  async list(placeId: string): Promise<FavoriteRecord[]> {
    // reject unsafe map keys before object access
    if (!validPlaceId(placeId)) throw new HostFilesError('invalid_path', 'invalid Place identity', 400);
    await this.mutation;
    const records = (await this.read()).places[placeId] ?? [];
    requireBoundedControlArray(records);
    return structuredClone(records);
  }

  // add idempotently without silently acknowledging a replaced object
  async add(placeId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord> {
    // reject unsafe inputs before durable mutation
    if (!validPlaceId(placeId) || !isHostFilesPath(path)) throw new HostFilesError('invalid_path', 'invalid favorite path', 400);
    let result: FavoriteRecord | undefined;
    await this.mutate(stored => {
      const records = stored.places[placeId] ?? [];
      const existing = records.find(record => record.path === path);
      // return the existing stable object without a duplicate
      if (existing !== undefined && sameFavoriteObject(existing.identity, identity)) { result = existing; return; }
      // require explicit acknowledgement for path replacement
      if (existing !== undefined) throw new HostFilesError('favorite_replaced', 'favorite path now identifies a different object', 409);
      const total = Object.values(stored.places).reduce((count, items) => count + items.length, 0);
      // preserve bounded storage
      if (records.length >= maxPerPlace || total >= maxTotal) throw new HostFilesError('limit_exceeded', 'favorite limit reached', 413);
      const timestamp = new Date(this.now()).toISOString();
      result = { id: randomUUID(), path, identity, createdAt: timestamp, updatedAt: timestamp };
      stored.places[placeId] = [...records, result];
    });
    // mutation always assigns one result or throws
    if (result === undefined) throw new Error('favorite add did not settle');
    return structuredClone(result);
  }

  // explicitly bind an existing favorite to the current object at its same path
  async acknowledge(placeId: string, favoriteId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord> {
    // reject unsafe inputs before durable mutation
    if (!validPlaceId(placeId) || !validId(favoriteId) || !isHostFilesPath(path)) throw new HostFilesError('invalid_path', 'invalid favorite identity', 400);
    let result: FavoriteRecord | undefined;
    await this.mutate(stored => {
      const records = stored.places[placeId] ?? [];
      const index = records.findIndex(record => record.id === favoriteId);
      // refuse a missing favorite without revealing another Place
      if (index < 0) throw new HostFilesError('not_found', 'favorite not found', 404);
      const current = records[index]!;
      // prevent acknowledgement with a token for another path
      if (current.path !== path) throw new HostFilesError('stale_object', 'favorite path changed', 409);
      result = { ...current, identity, updatedAt: new Date(this.now()).toISOString(), freshness: undefined };
      records[index] = result;
      stored.places[placeId] = records;
    });
    // mutation always assigns one result or throws
    if (result === undefined) throw new Error('favorite acknowledgement did not settle');
    return structuredClone(result);
  }

  // remove one favorite from one exact Place
  async remove(placeId: string, favoriteId: string): Promise<boolean> {
    // reject unsafe inputs before durable mutation
    if (!validPlaceId(placeId) || !validId(favoriteId)) return false;
    let removed = false;
    await this.mutate(stored => {
      const records = stored.places[placeId] ?? [];
      const next = records.filter(record => record.id !== favoriteId);
      removed = next.length !== records.length;
      // discard empty Place keys
      if (next.length === 0) delete stored.places[placeId];
      else stored.places[placeId] = next;
    });
    return removed;
  }

  // atomically retarget exact favorites after destination publication
  async rewrite(rewrites: readonly FavoriteRewrite[]): Promise<void> {
    // avoid a storage write for an empty move
    if (rewrites.length === 0) return;
    await this.mutate(stored => {
      // update every addressed record in one persisted generation
      for (const rewrite of rewrites) {
        const records = stored.places[rewrite.placeId] ?? [];
        const index = records.findIndex(record => record.id === rewrite.favoriteId);
        // fail closed on a concurrent favorite mutation
        if (index < 0) throw new HostFilesError('favorite_freshness_pending', 'favorite changed during move', 409);
        const current = records[index]!;
        records[index] = { ...current, path: rewrite.path, identity: rewrite.identity, updatedAt: new Date(this.now()).toISOString(), ...(rewrite.freshness === undefined ? { freshness: undefined } : { freshness: rewrite.freshness }) };
        stored.places[rewrite.placeId] = records;
      }
    });
  }

  // find favorites at one path or below one directory across every Place
  async beneath(path: string): Promise<Array<{ placeId: string; favorite: FavoriteRecord }>> {
    await this.mutation;
    const stored = await this.read();
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const matches: Array<{ placeId: string; favorite: FavoriteRecord }> = [];
    let controlBytes = 2;
    // scan the bounded persisted map
    for (const [placeId, records] of Object.entries(stored.places)) {
      // retain exact and descendant favorites
      for (const favorite of records) {
        // include only the moved subtree
        if (favorite.path === path || favorite.path.startsWith(prefix)) {
          const match = { placeId, favorite: structuredClone(favorite) };
          controlBytes += controlArrayItemBytes(match, matches.length);
          // stop before repeated Place ids overflow one control result
          if (controlBytes > maxControlMetadataBytes) throw new HostFilesError('limit_exceeded', 'favorite metadata exceeds transfer limits', 413);
          matches.push(match);
        }
      }
    }
    return matches;
  }

  // serialize one durable mutation
  private async mutate(change: (stored: StoredFavorites) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      change(stored);
      await this.write(stored);
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  // read and fully validate persisted favorites
  private async read(): Promise<StoredFavorites> {
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      // initialize only a missing file
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, places: {} };
      throw error;
    }
    let serialized: string;
    try {
      const info = await handle.stat();
      // reject an unexpectedly large persisted file before allocation
      if (!info.isFile() || info.size > maxFileBytes) throw new Error('file favorites exceed storage limits');
      serialized = await handle.readFile('utf8');
    } finally { await handle.close(); }
    const parsed = JSON.parse(serialized) as unknown;
    // require the one supported schema version
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1) throw new Error('invalid file favorites file');
    const places = (parsed as Record<string, unknown>).places;
    // require one bounded Place map
    if (places === null || typeof places !== 'object' || Array.isArray(places) || Object.keys(places).length > maxPlaces) throw new Error('invalid file favorites file');
    const stored: StoredFavorites = { version: 1, places: Object.create(null) as Record<string, FavoriteRecord[]> };
    let total = 0;
    // validate every Place and favorite record
    for (const [placeId, value] of Object.entries(places)) {
      // reject unsafe Place keys and oversized lists
      if (!validPlaceId(placeId) || !Array.isArray(value) || value.length > maxPerPlace || !value.every(validFavorite)) throw new Error('invalid file favorites file');
      const paths = new Set(value.map(record => (record as FavoriteRecord).path));
      const ids = new Set(value.map(record => (record as FavoriteRecord).id));
      // reject duplicate records
      if (paths.size !== value.length || ids.size !== value.length) throw new Error('invalid file favorites file');
      stored.places[placeId] = value as FavoriteRecord[];
      total += value.length;
    }
    // bound the aggregate record count
    if (total > maxTotal) throw new Error('file favorites exceed storage limits');
    return stored;
  }

  // atomically write one mode-0600 favorites generation
  private async write(stored: StoredFavorites): Promise<void> {
    const entries = Object.entries(stored.places);
    const total = entries.reduce((count, [, records]) => count + records.length, 0);
    // revalidate post-mutation limits before serialization
    if (entries.length > maxPlaces || total > maxTotal || entries.some(([placeId, records]) => !validPlaceId(placeId) || records.length > maxPerPlace || !records.every(validFavorite))) throw new Error('file favorites exceed storage limits');
    const serialized = JSON.stringify(stored);
    // bound the next persisted generation
    if (Buffer.byteLength(serialized) > maxFileBytes) throw new Error('file favorites exceed storage limits');
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next-${randomBytes(12).toString('hex')}`;
    const handle = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let published = false;
    try {
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      await rename(next, this.file);
      published = true;
    } finally {
      await handle.close().catch(() => undefined);
      // remove only this call's exclusive temporary file
      if (!published) await unlink(next).catch(() => undefined);
    }
  }
}

export class BackendHostFileFavorites implements HostFileFavorites {
  // bind all favorite mutations to the one backend engine owner
  constructor(private readonly backend: HostFilesBackend) {}

  // list one Place through the backend owner
  async list(placeId: string): Promise<FavoriteRecord[]> {
    return await this.backend.request({ kind: 'favorites-list', placeId });
  }

  // add one favorite through the backend owner
  async add(placeId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord> {
    return await this.backend.request({ kind: 'favorites-add', placeId, path, identity });
  }

  // acknowledge one replacement through the backend owner
  async acknowledge(placeId: string, favoriteId: string, path: string, identity: HostFileIdentity): Promise<FavoriteRecord> {
    return await this.backend.request({ kind: 'favorites-acknowledge', placeId, favoriteId, path, identity });
  }

  // remove one favorite through the backend owner
  async remove(placeId: string, favoriteId: string): Promise<boolean> {
    return await this.backend.request({ kind: 'favorites-remove', placeId, favoriteId });
  }

  // atomically rewrite favorites through the backend owner
  async rewrite(rewrites: readonly FavoriteRewrite[]): Promise<void> {
    requireBoundedControlArray(rewrites, Buffer.byteLength('{"kind":"favorites-rewrite","rewrites":[]}'));
    await this.backend.request({ kind: 'favorites-rewrite', rewrites: [...rewrites] });
  }

  // find moved favorites through the backend owner
  async beneath(path: string): Promise<HostFilesFavoriteMatch[]> {
    return await this.backend.request({ kind: 'favorites-beneath', path });
  }
}
