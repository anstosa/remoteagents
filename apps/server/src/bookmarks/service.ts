import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { adapterFor } from '../adapters/registry.js';
import { agentKinds, type AgentKind } from '../adapters/types.js';

// A saved chat carries its Adapter kind so it resumes through the right Adapter;
// an absent kind means `codex`, keeping every pre-existing bookmark file valid.
export type Bookmark = { id: string; threadId: string; title: string; createdAt: string; kind?: AgentKind };
export type BookmarkServiceOptions = { file?: string };
type StoredBookmarks = Record<string, Bookmark[]>;

const maxBookmarksPerKey = 50;
const maxSaveKeys = 100;
const maxTitleLength = 120;
// validate one shared persistence key
const validSaveKey = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
// validate one generated bookmark identifier
const validBookmarkId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
// validate one display title
const validTitle = (value: string) => value.trim().length > 0 && value.length <= maxTitleLength && !value.includes('\0');
// validate one persisted timestamp
const validCreatedAt = (value: string) => Number.isFinite(Date.parse(value));
// classify one persisted kind, treating an absent value as `codex`
const bookmarkKind = (value: unknown): AgentKind | undefined => value === undefined ? 'codex' : (agentKinds as readonly string[]).includes(value as string) ? value as AgentKind : undefined;
// validate one thread id against its own Adapter (the registry is code, not plugins)
const validThreadId = (kind: AgentKind, threadId: string): boolean => adapterFor(kind)?.conversations?.validId(threadId) ?? false;

// validate one persisted bookmark
function isBookmark(value: unknown): value is Bookmark {
  // require one plain object
  if (value === null || typeof value !== 'object') return false;
  const bookmark = value as { id?: unknown; threadId?: unknown; title?: unknown; createdAt?: unknown; kind?: unknown };
  const kind = bookmarkKind(bookmark.kind);
  // reject an unknown kind before validating its thread id
  if (kind === undefined) return false;
  return typeof bookmark.id === 'string' && validBookmarkId(bookmark.id)
    && typeof bookmark.threadId === 'string' && validThreadId(kind, bookmark.threadId)
    && typeof bookmark.title === 'string' && validTitle(bookmark.title)
    && typeof bookmark.createdAt === 'string' && validCreatedAt(bookmark.createdAt);
}

export class BookmarkService {
  private readonly file: string;
  private mutation = Promise.resolve();

  // configure durable bookmark storage
  constructor(options: BookmarkServiceOptions = {}) {
    this.file = options.file ?? process.env.RAC_BOOKMARKS_FILE ?? '.data/bookmarks.json';
  }

  // list one shared bookmark group
  async list(saveKey: string): Promise<Bookmark[] | undefined> {
    // reject unsafe storage keys
    if (!validSaveKey(saveKey)) return undefined;
    await this.mutation;
    return [...((await this.read())[saveKey] ?? [])];
  }

  // find one bookmark in a shared group
  async get(saveKey: string, bookmarkId: string): Promise<Bookmark | undefined> {
    // reject unsafe lookup identifiers
    if (!validSaveKey(saveKey) || !validBookmarkId(bookmarkId)) return undefined;
    await this.mutation;
    return (await this.read())[saveKey]?.find(bookmark => bookmark.id === bookmarkId);
  }

  // persist one known conversation
  async create(saveKey: string, value: Omit<Bookmark, 'id'>): Promise<Bookmark | undefined> {
    const kind = value.kind ?? 'codex';
    // reject malformed bookmark material
    if (!validSaveKey(saveKey) || !validThreadId(kind, value.threadId) || !validTitle(value.title) || !validCreatedAt(value.createdAt)) return undefined;
    return await this.mutate(stored => {
      const bookmarks = stored[saveKey] ?? [];
      const existing = bookmarks.find(bookmark => bookmark.threadId === value.threadId && (bookmark.kind ?? 'codex') === kind);
      // deduplicate the same conversation
      if (existing !== undefined) return { ...existing };
      // enforce group and file bounds
      if (bookmarks.length >= maxBookmarksPerKey || stored[saveKey] === undefined && Object.keys(stored).length >= maxSaveKeys) return undefined;
      // omit a `codex` kind so pre-existing files stay byte-for-byte compatible
      const bookmark: Bookmark = { id: randomBytes(18).toString('base64url'), threadId: value.threadId, title: value.title, createdAt: value.createdAt, ...(kind === 'codex' ? {} : { kind }) };
      stored[saveKey] = [bookmark, ...bookmarks];
      return { ...bookmark };
    });
  }

  // rename one saved chat
  async rename(saveKey: string, bookmarkId: string, title: string): Promise<Bookmark | undefined> {
    // reject unsafe mutation material
    if (!validSaveKey(saveKey) || !validBookmarkId(bookmarkId) || !validTitle(title)) return undefined;
    return await this.mutate(stored => {
      const bookmark = stored[saveKey]?.find(candidate => candidate.id === bookmarkId);
      // require one matching bookmark
      if (bookmark === undefined) return undefined;
      bookmark.title = title;
      return { ...bookmark };
    });
  }

  // delete one bookmark
  async remove(saveKey: string, bookmarkId: string): Promise<Bookmark | undefined> {
    // reject unsafe mutation identifiers
    if (!validSaveKey(saveKey) || !validBookmarkId(bookmarkId)) return undefined;
    return await this.mutate(stored => {
      const bookmarks = stored[saveKey] ?? [];
      const index = bookmarks.findIndex(bookmark => bookmark.id === bookmarkId);
      // require one matching bookmark
      if (index < 0) return undefined;
      const [removed] = bookmarks.splice(index, 1);
      // discard empty groups
      if (bookmarks.length === 0) delete stored[saveKey];
      return removed;
    });
  }

  // serialize bookmark mutations
  private async mutate<T>(change: (stored: StoredBookmarks) => T): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // read and validate bookmark storage
  private async read(): Promise<StoredBookmarks> {
    let serialized: string;
    try {
      serialized = await readFile(this.file, 'utf8');
    } catch (error) {
      // initialize missing storage lazily
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const raw = JSON.parse(serialized) as unknown;
    // require one bounded map
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid bookmarks file');
    const stored: StoredBookmarks = {};
    // validate each shared group
    for (const [saveKey, bookmarks] of Object.entries(raw)) {
      if (!validSaveKey(saveKey) || !Array.isArray(bookmarks) || bookmarks.length > maxBookmarksPerKey || bookmarks.some(bookmark => !isBookmark(bookmark))) throw new Error('invalid bookmarks file');
      stored[saveKey] = bookmarks;
    }
    // enforce total group bounds
    if (Object.keys(stored).length > maxSaveKeys) throw new Error('bookmarks file exceeds storage limits');
    return stored;
  }

  // atomically persist bookmark storage
  private async write(value: StoredBookmarks): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
