import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { agentKinds, type AgentKind } from '../adapters/types.js';

/**
 * Per-scope launch and pin state persisted outside the config file (ADR 0003).
 * Keyed by the Worktree wire id `<projectId>:<realpath>` for a Worktree's pin and
 * last-used `launchProfile`, by `<projectId>` for a Project's last-used profile, and
 * by the reserved `scratch` key for the Scratch group. `pinned` is an explicit
 * operator override; its absence means the default (a Main worktree pinned, a Linked
 * worktree not), which discovery applies. Sandboxed is never stored.
 */
export type WorktreeRecord = { pinned?: boolean; launchProfile?: AgentKind };
type StoredRecords = Record<string, WorktreeRecord>;

// the reserved key for the single Scratch launch group
export const scratchLaunchKey = 'scratch';
// the Project-scoped last-used profile is keyed by `<projectId>`; the worktree key by
// `<projectId>:<realpath>`. Both flow through this store.
export const projectLaunchKey = (projectId: string): string => projectId;
const maxKeys = 2_000;
// keys are `scratch`, a `<projectId>`, or a `<projectId>:<realpath>` worktree key —
// bounded, single-line, no NUL, so a stray value never corrupts the on-disk map
const validKey = (value: string) => value.length >= 1 && value.length <= 4096 && !/[\0\n\r]/u.test(value);
const isKind = (value: unknown): value is AgentKind => (agentKinds as readonly string[]).includes(value as string);

// validate one persisted record
function isRecord(value: unknown): value is WorktreeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { pinned?: unknown; launchProfile?: unknown };
  return (record.pinned === undefined || typeof record.pinned === 'boolean') && (record.launchProfile === undefined || isKind(record.launchProfile));
}

export class WorktreeLaunchStore {
  private readonly file: string;
  private mutation = Promise.resolve();

  // configure durable worktree launch storage
  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? process.env.RAC_WORKTREES_FILE ?? '.data/worktrees.json';
  }

  // the last Adapter kind launched under this key, if any is still recorded
  async launchProfile(key: string): Promise<AgentKind | undefined> {
    if (!validKey(key)) return undefined;
    await this.mutation;
    return (await this.read())[key]?.launchProfile;
  }

  // the last Adapter kind launched under every key, read once (the dashboard resolves
  // many scopes per poll and reads the file once rather than once per scope)
  async launchProfiles(): Promise<Record<string, AgentKind | undefined>> {
    await this.mutation;
    const stored = await this.read();
    return Object.fromEntries(Object.entries(stored).map(([key, record]) => [key, record.launchProfile]));
  }

  // every explicit pin override, read once so discovery folds them into one worktree scan
  async pins(): Promise<Record<string, boolean>> {
    await this.mutation;
    const stored = await this.read();
    const pins: Record<string, boolean> = {};
    for (const [key, record] of Object.entries(stored)) if (record.pinned !== undefined) pins[key] = record.pinned;
    return pins;
  }

  // record the kind a launch or restart used so it resolves first next time
  async rememberLaunchProfile(key: string, kind: AgentKind): Promise<void> {
    // reject unsafe keys and unknown kinds rather than persisting them
    if (!validKey(key) || !isKind(kind)) return;
    await this.mutate(stored => {
      // bound the file; a new key beyond the limit is dropped rather than growing unbounded
      if (stored[key] === undefined && Object.keys(stored).length >= maxKeys) return;
      stored[key] = { ...stored[key], launchProfile: kind };
    });
  }

  // record an explicit pin override for one Worktree, the tab-menu / launcher toggle
  async setPinned(key: string, pinned: boolean): Promise<void> {
    if (!validKey(key)) return;
    await this.mutate(stored => {
      if (stored[key] === undefined && Object.keys(stored).length >= maxKeys) return;
      stored[key] = { ...stored[key], pinned };
    });
  }

  // every stored key, so discovery can spot a worktree key git lists nowhere (Prune's
  // orphaned-record group). Read once per worktree scan, like `pins()`.
  async keys(): Promise<string[]> {
    await this.mutation;
    return Object.keys(await this.read());
  }

  // forget one Worktree's pin and last-used kind — Remove deletes the record outright
  async delete(key: string): Promise<void> {
    if (!validKey(key)) return;
    await this.mutate(stored => { delete stored[key]; });
  }

  // serialize record mutations
  private async mutate(change: (stored: StoredRecords) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      change(stored);
      await this.write(stored);
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  // read and validate worktree storage
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
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid worktrees file');
    const stored: StoredRecords = {};
    for (const [key, record] of Object.entries(raw)) {
      if (!validKey(key) || !isRecord(record)) throw new Error('invalid worktrees file');
      stored[key] = record;
    }
    if (Object.keys(stored).length > maxKeys) throw new Error('worktrees file exceeds storage limits');
    return stored;
  }

  // atomically persist worktree storage
  private async write(value: StoredRecords): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
