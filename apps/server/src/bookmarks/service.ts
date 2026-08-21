import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodexSessionRef } from '../domain/models.js';

export type CodexBookmark = { id: string; threadId: string; title: string; createdAt: string };
export type CodexBookmarkServiceOptions = { file?: string; codexHome?: string };
type StoredBookmarks = Record<string, CodexBookmark[]>;
type SessionMetadata = { id: string; parentThreadId?: string };

const maxBookmarksPerKey = 50;
const maxSaveKeys = 100;
const maxTitleLength = 120;
const maxMetadataBytes = 128 * 1024;
const maxTitleScanBytes = 4 * 1024 * 1024;
// validate one shared persistence key
const validSaveKey = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
// validate one exact Codex thread UUID
export const validCodexThreadId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
// validate one generated bookmark identifier
const validBookmarkId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
// validate one display title
const validTitle = (value: string) => value.trim().length > 0 && value.length <= maxTitleLength && !value.includes('\0');
// validate one persisted timestamp
const validCreatedAt = (value: string) => Number.isFinite(Date.parse(value));

// validate one persisted bookmark
function isBookmark(value: unknown): value is CodexBookmark {
  // require one plain object
  if (value === null || typeof value !== 'object') return false;
  const bookmark = value as { id?: unknown; threadId?: unknown; title?: unknown; createdAt?: unknown };
  return typeof bookmark.id === 'string' && validBookmarkId(bookmark.id)
    && typeof bookmark.threadId === 'string' && validCodexThreadId(bookmark.threadId)
    && typeof bookmark.title === 'string' && validTitle(bookmark.title)
    && typeof bookmark.createdAt === 'string' && validCreatedAt(bookmark.createdAt);
}

// normalize a user message into a compact label
function bookmarkTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  // ignore injected session context
  if (!normalized || normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')) return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

// extract message text from one Codex response item
function userMessage(payload: unknown): string | undefined {
  // require one user message payload
  if (payload === null || typeof payload !== 'object') return undefined;
  const message = payload as { type?: unknown; role?: unknown; content?: unknown };
  // reject non-user records
  if (message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((item): item is { text: string } => item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string')
    .map(item => item.text)
    .join('\n');
  return bookmarkTitle(text);
}

// read bounded metadata from one Codex rollout
async function sessionMetadata(file: string): Promise<SessionMetadata | undefined> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxMetadataBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    // reject missing records
    if (!firstLine) return undefined;
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: unknown };
    // require session metadata
    if (record.type !== 'session_meta' || record.payload === null || typeof record.payload !== 'object') return undefined;
    const payload = record.payload as { id?: unknown; cwd?: unknown; originator?: unknown; parent_thread_id?: unknown };
    // accept only top-level interactive Codex sessions
    if (typeof payload.id !== 'string' || !validCodexThreadId(payload.id) || typeof payload.cwd !== 'string' || payload.originator !== 'codex-tui') return undefined;
    return { id: payload.id, ...(typeof payload.parent_thread_id === 'string' ? { parentThreadId: payload.parent_thread_id } : {}) };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// find the latest useful user message in one rollout
async function sessionTitle(file: string): Promise<string | undefined> {
  let title: string | undefined;
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxTitleScanBytes);
    const offset = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // discard a partial leading record
    if (offset > 0) lines.shift();
    // scan the bounded tail in order
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
        // retain the newest visible user request
        if (record.type === 'response_item') title = userMessage(record.payload) ?? title;
      } catch {
        // preserve earlier valid records
      }
    }
  } finally {
    await handle.close();
  }
  return title;
}

// validate one session-relative rollout path
function validSessionRef(value: CodexSessionRef): boolean {
  const parts = value.relativePath.split('/');
  return validCodexThreadId(value.id)
    && value.relativePath.length <= 4_096
    && parts[0] === 'sessions'
    && parts.length >= 3
    && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
    && value.relativePath.endsWith(`-${value.id}.jsonl`);
}

export class CodexBookmarkService {
  private readonly file: string;
  private readonly codexHome: string;
  private mutation = Promise.resolve();

  // configure durable bookmark and Codex session storage
  constructor(options: CodexBookmarkServiceOptions = {}) {
    this.file = options.file ?? process.env.RAC_BOOKMARKS_FILE ?? '.data/bookmarks.json';
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex');
  }

  // list one shared bookmark group
  async list(saveKey: string): Promise<CodexBookmark[] | undefined> {
    // reject unsafe storage keys
    if (!validSaveKey(saveKey)) return undefined;
    await this.mutation;
    return [...((await this.read())[saveKey] ?? [])];
  }

  // find one bookmark in a shared group
  async get(saveKey: string, bookmarkId: string): Promise<CodexBookmark | undefined> {
    // reject unsafe lookup identifiers
    if (!validSaveKey(saveKey) || !validBookmarkId(bookmarkId)) return undefined;
    await this.mutation;
    return (await this.read())[saveKey]?.find(bookmark => bookmark.id === bookmarkId);
  }

  // persist one known Codex thread
  async create(saveKey: string, value: Omit<CodexBookmark, 'id'>): Promise<CodexBookmark | undefined> {
    // reject malformed bookmark material
    if (!validSaveKey(saveKey) || !validCodexThreadId(value.threadId) || !validTitle(value.title) || !validCreatedAt(value.createdAt)) return undefined;
    return await this.mutate(stored => {
      const bookmarks = stored[saveKey] ?? [];
      const existing = bookmarks.find(bookmark => bookmark.threadId === value.threadId);
      // deduplicate the same conversation
      if (existing !== undefined) return { ...existing };
      // enforce group and file bounds
      if (bookmarks.length >= maxBookmarksPerKey || stored[saveKey] === undefined && Object.keys(stored).length >= maxSaveKeys) return undefined;
      const bookmark: CodexBookmark = { id: randomBytes(18).toString('base64url'), ...value };
      stored[saveKey] = [bookmark, ...bookmarks];
      return { ...bookmark };
    });
  }

  // resolve and persist the selected agent's top-level Codex conversation
  async bookmarkCurrent(saveKey: string, sessions: CodexSessionRef[]): Promise<CodexBookmark | undefined> {
    // require one safe group and exact session identities
    if (!validSaveKey(saveKey) || sessions.length === 0 || sessions.some(session => !validSessionRef(session))) return undefined;
    const selected = await this.selectedSession(sessions);
    // report unavailable session records
    if (selected === undefined) return undefined;
    const title = await sessionTitle(selected.file).catch(() => undefined);
    return await this.create(saveKey, { threadId: selected.id, title: title ?? `Codex chat ${selected.id.slice(0, 8)}`, createdAt: new Date().toISOString() });
  }

  // resolve the selected agent's top-level Codex thread
  async currentThreadId(sessions: CodexSessionRef[]): Promise<string | undefined> {
    // require exact session identities
    if (sessions.length === 0 || sessions.some(session => !validSessionRef(session))) return undefined;
    return (await this.selectedSession(sessions))?.id;
  }

  // rename one saved chat
  async rename(saveKey: string, bookmarkId: string, title: string): Promise<CodexBookmark | undefined> {
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
  async remove(saveKey: string, bookmarkId: string): Promise<CodexBookmark | undefined> {
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

  // locate the selected pane's one top-level rollout
  private async selectedSession(sessions: CodexSessionRef[]): Promise<{ id: string; file: string } | undefined> {
    const matches: Array<{ id: string; file: string }> = [];
    // inspect only rollouts held open by the selected pane
    for (const session of sessions) {
      const file = join(this.codexHome, session.relativePath);
      const metadata = await sessionMetadata(file).catch(() => undefined);
      // retain top-level sessions only
      if (metadata !== undefined && metadata.parentThreadId === undefined && metadata.id === session.id) matches.push({ id: metadata.id, file });
    }
    // fail closed on missing or ambiguous pane identity
    if (matches.length !== 1) return undefined;
    return matches[0];
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
