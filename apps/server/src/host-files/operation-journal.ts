import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HostFilesError, isHostFileIdentity, isHostFilesPath, type HostFileIdentity } from './contracts.js';

export type OwnedObject = { path: string; identity: HostFileIdentity };
export type FileJournalRecord = {
  id: string;
  kind: 'copy'|'upload'|'special';
  phase: string;
  source?: OwnedObject;
  destination: string;
  stage?: string;
  backup?: string;
  backupContainer?: string;
  owned: OwnedObject[];
  published?: OwnedObject;
  favorites?: Array<{ placeId: string; favoriteId: string; sourcePath: string; destinationPath: string; identity: HostFileIdentity }>;
  updatedAt: string;
};
const maxJournalBytes = 8 * 1024 * 1024;
const maxRecords = 128;

// validate persisted recovery state before allowing any cleanup
function journalRecord(value: unknown): value is FileJournalRecord {
  // require an ordinary record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // constrain every owned identity and path
  const owned = (item: unknown): item is OwnedObject => item !== null && typeof item === 'object'
    && isHostFilesPath((item as OwnedObject).path) && isHostFileIdentity((item as OwnedObject).identity);
  return typeof record.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(record.id)
    && ['copy', 'upload', 'special'].includes(String(record.kind)) && typeof record.phase === 'string' && record.phase.length <= 80
    && isHostFilesPath(record.destination) && typeof record.updatedAt === 'string'
    && (record.source === undefined || owned(record.source)) && (record.published === undefined || owned(record.published))
    && [record.stage, record.backup, record.backupContainer].every(path => path === undefined || isHostFilesPath(path))
    && (record.favorites === undefined || Array.isArray(record.favorites) && record.favorites.length <= 20_000 && record.favorites.every(item => item !== null && typeof item === 'object' && typeof item.placeId === 'string' && item.placeId.length <= 4096 && typeof item.favoriteId === 'string' && isHostFilesPath(item.sourcePath) && isHostFilesPath(item.destinationPath) && isHostFileIdentity(item.identity)))
    && Array.isArray(record.owned) && record.owned.length <= 20_010 && record.owned.every(owned);
}

// serialize bounded atomic recovery writes without exposing operation paths
export class FileOperationJournal {
  private readonly path: string;
  private records = new Map<string, FileJournalRecord>();
  private loaded?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();

  // isolate native test journals from the production persistent file
  constructor(path = process.env.RAC_FILE_OPERATION_JOURNAL ?? '.data/file-operation-journal.json') {
    this.path = resolve(path);
  }

  // read and validate one versioned recovery document
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      let contents: Buffer;
      try {
        const info = await stat(this.path);
        // refuse oversized state before allocating its contents
        if (info.size > maxJournalBytes) throw new HostFilesError('limit_exceeded', 'file recovery journal is too large', 503);
        contents = await readFile(this.path);
      } catch (error) {
        // an absent initial journal is empty
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      let value: unknown;
      try { value = JSON.parse(contents.toString('utf8')); }
      catch { throw new HostFilesError('bridge_unavailable', 'file recovery journal is invalid', 503); }
      const document = value as { version?: unknown; operations?: unknown };
      // reject unknown versions and malformed identities as a whole
      if (document?.version !== 1 || !Array.isArray(document.operations) || document.operations.length > maxRecords || !document.operations.every(journalRecord)) {
        throw new HostFilesError('bridge_unavailable', 'file recovery journal is invalid', 503);
      }
      this.records = new Map(document.operations.map(record => [record.id, record]));
    })();
    await this.loaded;
  }

  // commit the entire bounded journal through a private exclusive temporary file
  private async save(records: Map<string, FileJournalRecord>): Promise<void> {
    const contents = JSON.stringify({ version: 1, operations: [...records.values()] });
    // stop intake rather than lose uncommitted recovery evidence
    if (records.size > maxRecords || Buffer.byteLength(contents) > maxJournalBytes) throw new HostFilesError('limit_exceeded', 'file recovery journal is full', 503);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(12).toString('hex')}.next`;
    const handle = await open(temporary, 'wx', 0o600);
    let closed = false;
    try {
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, this.path);
      this.records = records;
    } finally {
      // close only the descriptor opened by this write
      if (!closed) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  // sequence store writes and allow a later retry after a failed commit
  private async mutate(change: (records: Map<string, FileJournalRecord>) => void): Promise<void> {
    const pending = this.pending.catch(() => undefined).then(async () => {
      await this.load();
      const records = new Map(this.records);
      change(records);
      await this.save(records);
    });
    this.pending = pending;
    await pending;
  }

  // retain a copy so callers cannot alter persisted authority accidentally
  async all(): Promise<FileJournalRecord[]> {
    await this.pending.catch(() => undefined);
    await this.load();
    return structuredClone([...this.records.values()]);
  }

  // durably advance a single operation's exact owned identities
  async put(record: FileJournalRecord): Promise<void> {
    // require internally generated records to satisfy the persisted contract too
    if (!journalRecord(record)) throw new HostFilesError('invalid_request', 'invalid file recovery record', 500);
    await this.mutate(records => { records.set(record.id, structuredClone(record)); });
  }

  // remove recovery evidence only after its exact objects have been resolved
  async remove(id: string): Promise<void> {
    await this.mutate(records => { records.delete(id); });
  }
}
