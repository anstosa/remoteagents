import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const contractVersion = 3;
const idempotencyLifetimeMs = 24 * 60 * 60_000;
const defaultMaxRecords = 2_000;

type IdempotencyState = 'in_progress' | 'completed' | 'failed' | 'unknown_outcome';
type IdempotencyRecord = { id: string; principalKey: string; tool: string; requestId: string; argumentsDigest: string; state: IdempotencyState; createdAt: number; updatedAt: number; result?: unknown };
type StoredPolicy = { version: 3; idempotency: IdempotencyRecord[] };

export type IdempotencyClaim =
  | { kind: 'claimed'; recordId: string }
  | { kind: 'replay'; recordId: string; state: Exclude<IdempotencyState, 'in_progress'>; result?: unknown }
  | { kind: 'in_progress'; recordId: string }
  | { kind: 'conflict' };

// persist replay safety for remote mutations
export class IntegrationPolicyService {
  private mutation = Promise.resolve();

  // retain one private policy store
  constructor(private readonly file = process.env.RAC_INTEGRATION_STATE_FILE ?? '.data/integration-state.json', private readonly maxRecords = defaultMaxRecords) {}

  // claim one mutation request before its side effect
  async claim(principalKey: string, tool: string, requestId: string, argumentsDigest: string): Promise<IdempotencyClaim> {
    return await this.mutate(stored => {
      const existing = stored.idempotency.find(record => record.principalKey === principalKey && record.tool === tool && record.requestId === requestId);
      // prevent a key from changing meaning
      if (existing !== undefined && existing.argumentsDigest !== argumentsDigest) return { kind: 'conflict' } as const;
      // return the current claim state
      if (existing?.state === 'in_progress') return { kind: 'in_progress', recordId: existing.id } as const;
      // replay every settled outcome
      if (existing !== undefined) return { kind: 'replay', recordId: existing.id, state: existing.state, ...(existing.result === undefined ? {} : { result: existing.result }) } as const;
      const now = Date.now();
      const record: IdempotencyRecord = { id: randomBytes(18).toString('base64url'), principalKey, tool, requestId, argumentsDigest, state: 'in_progress', createdAt: now, updatedAt: now };
      stored.idempotency.push(record);
      return { kind: 'claimed', recordId: record.id } as const;
    });
  }

  // finish one claimed mutation
  async finish(recordId: string, state: Exclude<IdempotencyState, 'in_progress'>, result?: unknown): Promise<boolean> {
    return await this.mutate(stored => {
      const record = stored.idempotency.find(candidate => candidate.id === recordId);
      // require the active claim
      if (record === undefined || record.state !== 'in_progress') return false;
      record.state = state;
      record.updatedAt = Date.now();
      // persist replayable bounded results
      if (result !== undefined && Buffer.byteLength(JSON.stringify(result)) <= 64 * 1_024) record.result = result;
      return true;
    });
  }

  // turn abandoned claims into fail-closed outcomes after restart
  async recoverUnknownOutcomes(): Promise<void> {
    await this.mutate(stored => {
      // mark every interrupted side effect as unknown
      for (const record of stored.idempotency) {
        // retain already settled outcomes
        if (record.state !== 'in_progress') continue;
        record.state = 'unknown_outcome';
        record.updatedAt = Date.now();
      }
    });
  }

  // serialize all state changes
  private async mutate<T>(change: (stored: StoredPolicy) => T): Promise<T> {
    const task = this.mutation.then(async () => {
      const stored = await this.read();
      prune(stored, this.maxRecords);
      const value = change(stored);
      // enforce capacity after every append
      prune(stored, this.maxRecords);
      await this.write(stored);
      return value;
    });
    this.mutation = task.then(() => undefined, () => undefined);
    return await task;
  }

  // read only validated policy state
  private async read(): Promise<StoredPolicy> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      // initialize only a genuinely missing store
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: contractVersion, idempotency: [] };
      throw error;
    }
    const parsed = JSON.parse(serialized) as unknown;
    // migrate legacy confirmation stores without retaining approvals
    if (validLegacyPolicy(parsed, this.maxRecords)) return { version: contractVersion, idempotency: parsed.idempotency };
    // fail closed rather than dropping replay protection
    if (!validStoredPolicy(parsed, this.maxRecords)) throw new Error('invalid integration policy state');
    return parsed;
  }

  // atomically replace private policy state
  private async write(stored: StoredPolicy): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await rename(next, this.file);
    await chmod(this.file, 0o600);
  }
}

// hash secrets and argument envelopes
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// remove expired and excess records
function prune(stored: StoredPolicy, maxRecords: number): void {
  const now = Date.now();
  stored.idempotency = stored.idempotency.filter(record => record.updatedAt + idempotencyLifetimeMs > now).slice(-maxRecords);
}

// validate persisted state before trusting it
function validStoredPolicy(value: unknown, maxRecords: number): value is StoredPolicy {
  // require the versioned envelope
  if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== contractVersion) return false;
  const stored = value as { idempotency?: unknown };
  // require one bounded record array
  return Array.isArray(stored.idempotency) && stored.idempotency.length <= maxRecords && stored.idempotency.every(validIdempotencyRecord);
}

// accept only replay-safe legacy state
function validLegacyPolicy(value: unknown, maxRecords: number): value is { version: 1 | 2; idempotency: IdempotencyRecord[] } {
  // require one recognized legacy envelope
  if (value === null || typeof value !== 'object' || ![1, 2].includes(Number((value as { version?: unknown }).version))) return false;
  const stored = value as { idempotency?: unknown };
  return Array.isArray(stored.idempotency) && stored.idempotency.length <= maxRecords && stored.idempotency.every(validIdempotencyRecord);
}

// validate one persisted idempotency record
function validIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  // require the fixed idempotency shape
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<IdempotencyRecord>;
  return typeof record.id === 'string' && typeof record.principalKey === 'string' && typeof record.tool === 'string' && typeof record.requestId === 'string' && typeof record.argumentsDigest === 'string' && ['in_progress', 'completed', 'failed', 'unknown_outcome'].includes(String(record.state)) && typeof record.createdAt === 'number' && typeof record.updatedAt === 'number';
}
