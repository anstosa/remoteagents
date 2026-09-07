import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { adapterFor } from '../adapters/registry.js';
import { agentKinds, sameConversation, type AgentKind } from '../adapters/types.js';

/**
 * The console's record that it named one Conversation (ADR 0007). It holds no
 * title — the name lives in the agent's own store — only which Conversation was
 * named through the console and when, so the quick list can be "what I named
 * here". `namedAt` orders the in-store record (newest first); the surfaced list
 * orders by the agent's own last-active time.
 */
export type ConsoleNamedConversation = { kind: AgentKind; id: string; namedAt: string };
export type ConsoleNamedServiceOptions = { file?: string };
type StoredRecords = Record<string, ConsoleNamedConversation[]>;

const maxRecordsPerKey = 100;
const maxSaveKeys = 100;
// validate one shared persistence key (a Project id or a Scratch key, keyed exactly like Notes)
const validSaveKey = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
// classify one persisted kind
const validKind = (value: unknown): value is AgentKind => typeof value === 'string' && (agentKinds as readonly string[]).includes(value);
// validate one Conversation id against its own Adapter (the registry is code, not plugins)
const validId = (kind: AgentKind, id: string): boolean => adapterFor(kind)?.conversations?.validId(id) ?? false;
// validate one persisted timestamp
const validNamedAt = (value: string) => Number.isFinite(Date.parse(value));

// validate one persisted record
function isRecord(value: unknown): value is ConsoleNamedConversation {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; id?: unknown; namedAt?: unknown };
  return validKind(record.kind)
    && typeof record.id === 'string' && validId(record.kind, record.id)
    && typeof record.namedAt === 'string' && validNamedAt(record.namedAt);
}

/**
 * Durable record of the Conversations the console named, keyed by Project id (or a
 * Scratch key) exactly like Notes and shared across a Project's Worktrees (ADR
 * 0003). One record per Conversation, newest first, at most 100 per key (oldest
 * dropped); never auto-pruned, so a transient read failure of the agent's store
 * cannot erase a record. Remove is the only deletion.
 */
export class ConsoleNamedConversationService {
  private readonly file: string;
  private mutation = Promise.resolve();

  constructor(options: ConsoleNamedServiceOptions = {}) {
    this.file = options.file ?? process.env.RAC_CONSOLE_NAMED_FILE ?? '.data/console-named-conversations.json';
  }

  // list one shared group of console-named records
  async list(saveKey: string): Promise<ConsoleNamedConversation[] | undefined> {
    // reject unsafe storage keys
    if (!validSaveKey(saveKey)) return undefined;
    await this.mutation;
    return [...((await this.read())[saveKey] ?? [])];
  }

  // remember that the console named one Conversation; naming it again refreshes `namedAt`
  // and moves it to the front. Returns the stored record, or undefined for invalid material.
  async record(saveKey: string, value: { kind: AgentKind; id: string; namedAt?: string }): Promise<ConsoleNamedConversation | undefined> {
    // reject malformed record material
    if (!validSaveKey(saveKey) || !validKind(value.kind) || !validId(value.kind, value.id)) return undefined;
    const namedAt = value.namedAt ?? new Date().toISOString();
    if (!validNamedAt(namedAt)) return undefined;
    return await this.mutate(stored => {
      // drop any earlier record of the same Conversation, then unshift the fresh one
      const records = (stored[saveKey] ?? []).filter(existing => !sameConversation(existing, value));
      // enforce the file-wide key bound only when adding a brand-new group
      if (stored[saveKey] === undefined && Object.keys(stored).length >= maxSaveKeys) return undefined;
      const record: ConsoleNamedConversation = { kind: value.kind, id: value.id, namedAt };
      // newest first; the oldest record past the cap falls off the end
      stored[saveKey] = [record, ...records].slice(0, maxRecordsPerKey);
      return { ...record };
    });
  }

  // forget the console's record of one Conversation; the transcript and its name survive.
  // Returns whether a record was removed (codex-family matched by id across the pair).
  async remove(saveKey: string, kind: AgentKind, id: string): Promise<boolean> {
    // reject unsafe mutation material
    if (!validSaveKey(saveKey) || !validKind(kind)) return false;
    return await this.mutate(stored => {
      const records = stored[saveKey];
      // require one matching group
      if (records === undefined) return false;
      const remaining = records.filter(record => !sameConversation(record, { kind, id }));
      // require one matching record
      if (remaining.length === records.length) return false;
      // discard empty groups
      if (remaining.length === 0) delete stored[saveKey]; else stored[saveKey] = remaining;
      return true;
    });
  }

  // serialize record mutations
  private async mutate<T>(change: (stored: StoredRecords) => T): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // read and validate record storage
  private async read(): Promise<StoredRecords> {
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
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid console-named conversations file');
    const stored: StoredRecords = {};
    // validate each shared group
    for (const [saveKey, records] of Object.entries(raw)) {
      if (!validSaveKey(saveKey) || !Array.isArray(records) || records.length > maxRecordsPerKey || records.some(record => !isRecord(record))) throw new Error('invalid console-named conversations file');
      stored[saveKey] = records as ConsoleNamedConversation[];
    }
    // enforce total group bounds
    if (Object.keys(stored).length > maxSaveKeys) throw new Error('console-named conversations file exceeds storage limits');
    return stored;
  }

  // atomically persist record storage
  private async write(value: StoredRecords): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
