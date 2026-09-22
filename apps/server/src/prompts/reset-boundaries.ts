import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AttentionState, PaneSnapshot } from '../adapters/types.js';

export type ResetBoundary = { id: string; agentId: string; at: number; before: PaneSnapshot; external?: boolean; resetPromptId?: string };
type StoredBoundaries = Record<string, ResetBoundary>;

const maxScopes = 500;
const maxScopeLength = 4_096;
const maxAgentIdLength = 4_096;
const maxTitleLength = 16_000;
const maxConversationIdLength = 4_096;
const attentionStates: readonly AttentionState[] = ['working', 'finished', 'question'];

// validate persisted string fields
const validString = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maximum && !value.includes('\0');

// validate one storage scope
const validScope = (value: string): boolean => validString(value, maxScopeLength);

// validate one durable identifier
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{12,64}$/u.test(value);

// validate one pane attention state
const validAttention = (value: unknown): value is AttentionState =>
  typeof value === 'string' && attentionStates.includes(value as AttentionState);

// parse one persisted reset boundary
const parseBoundary = (value: unknown): ResetBoundary | undefined => {
  // require the boundary object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const boundary = value as { id?: unknown; agentId?: unknown; at?: unknown; before?: unknown; external?: unknown; resetPromptId?: unknown };
  // require the pane snapshot object
  if (boundary.before === null || typeof boundary.before !== 'object' || Array.isArray(boundary.before)) return undefined;
  const before = boundary.before as { title?: unknown; attention?: unknown; conversationId?: unknown };
  // reject malformed fields
  if (!validId(boundary.id)
    || !validString(boundary.agentId, maxAgentIdLength)
    || typeof boundary.at !== 'number'
    || !Number.isFinite(boundary.at)
    || boundary.at < 0
    || !validString(before.title, maxTitleLength, true)
    || !validAttention(before.attention)
    || before.conversationId !== undefined && !validString(before.conversationId, maxConversationIdLength)
    || boundary.external !== undefined && typeof boundary.external !== 'boolean'
    || boundary.resetPromptId !== undefined && !validId(boundary.resetPromptId)) return undefined;
  return {
    id: boundary.id,
    agentId: boundary.agentId,
    at: boundary.at,
    before: {
      title: before.title,
      attention: before.attention,
      ...(typeof before.conversationId === 'string' ? { conversationId: before.conversationId } : {})
    },
    ...(typeof boundary.external === 'boolean' ? { external: boundary.external } : {}),
    ...(typeof boundary.resetPromptId === 'string' ? { resetPromptId: boundary.resetPromptId } : {})
  };
};

// clone without sharing caller-owned snapshots
const cloneBoundary = (boundary: ResetBoundary): ResetBoundary => structuredClone(boundary);

// clone the complete durable snapshot
const cloneStored = (stored: StoredBoundaries): StoredBoundaries => {
  const cloned = Object.create(null) as StoredBoundaries;
  // clone each scope independently
  for (const [scope, boundary] of Object.entries(stored)) cloned[scope] = cloneBoundary(boundary);
  return cloned;
};

export class ResetBoundaryStore {
  private mutation = Promise.resolve();
  private stored?: StoredBoundaries;

  // bind one durable sidecar file
  constructor(private readonly file: string) {}

  // read one cloned reset boundary
  async get(scope: string): Promise<ResetBoundary | undefined> {
    // reject invalid scopes
    if (!validScope(scope)) return undefined;
    await this.mutation;
    const boundary = (await this.read())[scope];
    return boundary === undefined ? undefined : cloneBoundary(boundary);
  }

  // persist one reset boundary
  async set(scope: string, boundary: ResetBoundary): Promise<void> {
    const parsed = parseBoundary(boundary);
    // reject invalid caller data
    if (!validScope(scope) || parsed === undefined) throw new Error('invalid reset boundary');
    await this.mutate(stored => {
      // enforce the scope cap before insertion
      if (stored[scope] === undefined && Object.keys(stored).length >= maxScopes) throw new Error('reset boundaries file exceeds storage limits');
      stored[scope] = parsed;
      return true;
    });
  }

  // remove one persisted reset boundary
  async clear(scope: string, expectedId?: string): Promise<void> {
    // reject invalid scope or marker ids
    if (!validScope(scope) || expectedId !== undefined && !validId(expectedId)) return;
    await this.mutate(stored => {
      // avoid rewriting unchanged storage
      if (stored[scope] === undefined || expectedId !== undefined && stored[scope].id !== expectedId) return false;
      delete stored[scope];
      return true;
    });
  }

  // serialize and publish durable mutations
  private async mutate(change: (stored: StoredBoundaries) => boolean): Promise<void> {
    const operation = this.mutation.then(async () => {
      const stored = cloneStored(await this.read());
      const changed = change(stored);
      // publish only actual changes
      if (!changed) return;
      await this.write(stored);
      this.stored = stored;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  // read and validate the durable snapshot
  private async read(): Promise<StoredBoundaries> {
    // reuse the process-owned durable snapshot
    if (this.stored !== undefined) return this.stored;
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(error => {
      // treat missing storage as empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
    // require a scope record
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid reset boundaries file');
    const entries = Object.entries(raw);
    // enforce the durable scope cap
    if (entries.length > maxScopes) throw new Error('reset boundaries file exceeds storage limits');
    const stored = Object.create(null) as StoredBoundaries;
    // validate every persisted boundary
    for (const [scope, value] of entries) {
      const boundary = parseBoundary(value);
      // reject one malformed entry
      if (!validScope(scope) || boundary === undefined) throw new Error('invalid reset boundaries file');
      stored[scope] = boundary;
    }
    this.stored = stored;
    return stored;
  }

  // atomically replace the durable snapshot
  private async write(value: StoredBoundaries): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
