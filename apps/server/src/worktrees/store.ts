import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { agentKinds, type AgentKind } from '../adapters/types.js';

/**
 * Per-Worktree launch state persisted outside the config file. Chunk 2 records
 * only the last-used `launchProfile` (the Adapter kind), keyed by the config
 * worktree id today and by `<projectId>:<realpath>` after chunk 3's migration;
 * a reserved `scratch` key holds the Scratch group's last-used kind. Later chunks
 * add per-Worktree pins beside it. Sandboxed is never stored.
 */
export type WorktreeRecord = { launchProfile?: AgentKind };
type StoredRecords = Record<string, WorktreeRecord>;

// the reserved key for the single Scratch launch group
export const scratchLaunchKey = 'scratch';
const maxKeys = 500;
// chunk 2 keys are config worktree ids and the reserved `scratch` group; chunk 3's
// migration re-keys worktrees by `<projectId>:<realpath>` and widens this then
const validKey = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
const isKind = (value: unknown): value is AgentKind => (agentKinds as readonly string[]).includes(value as string);

// validate one persisted record
function isRecord(value: unknown): value is WorktreeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { launchProfile?: unknown };
  return record.launchProfile === undefined || isKind(record.launchProfile);
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
