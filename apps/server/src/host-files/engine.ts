import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { HostFileFavoritesStore, sameFavoriteObject } from './favorites.js';
import { FileOperationJournal, type FileJournalRecord, type OwnedObject } from './operation-journal.js';
import {
  HostFilesError,
  type HostFileIdentity,
  type HostFileKind,
  type HostFileStat,
  type HostFilesBackend,
  type HostFilesCommand,
  type HostFilesCommandResult,
  type HostFilesItemResult,
  type HostFilesMutationResult,
  type HostFilesReadCommand,
  type HostFilesWriteCommand,
  type HostFilesWriteResult,
  type HostFilesTreeManifest,
  type HostFilesCopyCommand,
  type HostFilesLinkSpecialCommand,
  type HostFilesUnlinkSpecialCommand,
  type HostFilesSpecialLinkResult,
  type HostFilesSpecialUnlinkResult,
  isHostFilesCommand,
  isHostFilesWriteCommand,
} from './contracts.js';

const fileTypeMask = 0o170000;
const maxOwnerFileBytes = 1024 * 1024;
const tempPrefix = '.rac-files-';
const maxManifestMetadataBytes = 3 * 1024 * 1024;

// stop work promptly when the caller disconnects
function abort(signal?: AbortSignal): void {
  // surface one stable cancellation result
  if (signal?.aborted) throw new HostFilesError('partial_failure', 'file operation canceled', 409);
}

// classify one lstat result without following a symlink
export function kindOf(info: BigIntStats): HostFileKind {
  // preserve each visible Unix object type
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isFIFO()) return 'fifo';
  if (info.isSocket()) return 'socket';
  if (info.isBlockDevice()) return 'block';
  if (info.isCharacterDevice()) return 'character';
  return 'other';
}

// serialize bigint metadata for the broker protocol and token signer
export function identityOf(info: BigIntStats): HostFileIdentity {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    ctimeNs: info.ctimeNs.toString(),
    mtimeNs: info.mtimeNs.toString(),
    size: info.size.toString(),
    nlink: info.nlink.toString(),
    kind: kindOf(info),
  };
}

// compare all fields that make an issued object token fresh
export function sameIdentity(left: HostFileIdentity, right: HostFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs && left.size === right.size && left.nlink === right.nlink && left.kind === right.kind;
}

// render one complete Unix type and permission string
export function permissionString(info: BigIntStats): string {
  const mode = Number(info.mode);
  const type = info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : info.isFIFO() ? 'p' : info.isSocket() ? 's' : info.isBlockDevice() ? 'b' : info.isCharacterDevice() ? 'c' : info.isFile() ? '-' : '?';
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const chars = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  let value = type;
  // render each permission bit in display order
  for (let index = 0; index < bits.length; index += 1) value += (mode & bits[index]!) === 0 ? '-' : chars[index];
  // render set-id and sticky overlays
  if ((mode & 0o4000) !== 0) value = `${value.slice(0, 3)}${(mode & 0o100) === 0 ? 'S' : 's'}${value.slice(4)}`;
  // render group set-id state
  if ((mode & 0o2000) !== 0) value = `${value.slice(0, 6)}${(mode & 0o010) === 0 ? 'S' : 's'}${value.slice(7)}`;
  // render sticky directory state
  if ((mode & 0o1000) !== 0) value = `${value.slice(0, 9)}${(mode & 0o001) === 0 ? 'T' : 't'}`;
  return value;
}

// map filesystem failures into the stable public contract
export function hostFilesError(error: unknown): HostFilesError {
  // retain deliberate stable failures
  if (error instanceof HostFilesError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  // map permission failures without leaking native text
  if (code === 'EACCES' || code === 'EPERM') return new HostFilesError('permission_denied', 'permission denied', 403);
  // map missing objects
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HostFilesError('not_found', 'file or folder not found', 404);
  // map exclusive publication collisions
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return new HostFilesError('conflict', 'destination already exists', 409);
  // map unsupported cross-device special renames
  if (code === 'EXDEV') return new HostFilesError('unsupported_cross_filesystem_rename', 'object cannot be renamed across filesystems', 422);
  // map unsupported object relocation
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') return new HostFilesError('unsupported_relocation', 'object cannot be relocated', 422);
  return new HostFilesError('partial_failure', 'filesystem operation failed', 500);
}

// require an absolute, bounded host path before reaching fs calls
function checkedPath(path: string): string {
  // reject relative and NUL-bearing paths
  if (!isAbsolute(path) || path.length > 4096 || path.includes('\0')) throw new HostFilesError('invalid_path', 'invalid host path', 400);
  return resolve(path);
}

// select one collision suffix while preserving a regular extension
export function keepBothPath(path: string, attempt = 1): string {
  const folder = dirname(path);
  const name = basename(path);
  const extension = name.startsWith('.') ? '' : extname(name);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  const suffix = attempt === 1 ? ' (copy)' : ` (copy ${attempt})`;
  return join(folder, `${stem}${suffix}${extension}`);
}

// load bounded uid labels from the host passwd file
async function ownerLabels(): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  const size = await stat('/etc/passwd').then(info => info.size, () => 0);
  // bound the account database before reading it
  if (size > maxOwnerFileBytes) return labels;
  const content = await readFile('/etc/passwd').catch(() => Buffer.alloc(0));
  // ignore an unexpectedly large or unavailable account database
  if (content.length > maxOwnerFileBytes) return labels;
  // parse only conventional bounded passwd rows
  for (const line of content.toString('utf8').split('\n')) {
    const fields = line.split(':');
    const uid = Number(fields[2]);
    // retain one safe account label per numeric uid
    if (fields.length >= 3 && fields[0] && Number.isInteger(uid) && uid >= 0) labels.set(uid, fields[0]);
  }
  return labels;
}

// resolve a symlink target kind for display without hiding an inaccessible row
async function targetKind(path: string): Promise<HostFileStat['symlinkTargetKind']> {
  try {
    const target = await stat(path, { bigint: true });
    const kind = kindOf(target);
    // collapse special target kinds for the row contract
    if (kind === 'file' || kind === 'directory') return kind;
    return 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // distinguish absent and inaccessible targets
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'EACCES' || code === 'EPERM') return 'inaccessible';
    return 'other';
  }
}

// build one JSON-safe metadata record
async function inspect(path: string, labels: Map<number, string>, followSymlink = false): Promise<HostFileStat> {
  const requested = checkedPath(path);
  try {
    const effective = followSymlink ? await realpath(requested) : requested;
    const info = await lstat(effective, { bigint: true });
    const uid = Number(info.uid);
    const kind = kindOf(info);
    return {
      path: effective,
      name: basename(effective) || effective,
      ...identityOf(info),
      uid,
      owner: labels.get(uid) ?? `#${uid}`,
      permissions: permissionString(info),
      mode: Number(info.mode & BigInt(fileTypeMask | 0o7777)),
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: Number(info.size),
      ...(kind === 'symlink' ? { symlinkTargetKind: await targetKind(effective) } : {}),
    };
  } catch (error) {
    throw hostFilesError(error);
  }
}

// compare fields that survive the engine's own link and rename operations
function stableIdentity(left: HostFileIdentity, right: HostFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

// inspect one exact path without following its final symlink
async function identityAt(path: string): Promise<HostFileIdentity> {
  return identityOf(await lstat(path, { bigint: true }));
}

// distinguish an absent child from a permission or transport failure
async function optionalIdentity(path: string): Promise<HostFileIdentity | undefined> {
  try { return await identityAt(path); }
  catch (error) {
    // only a genuinely missing final leaf is absent
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// bind every destructive step to the most recent full identity
async function requireIdentity(path: string, expected: HostFileIdentity, stable = false): Promise<HostFileIdentity> {
  const current = await identityAt(path);
  // detect substitution and external metadata or content edits
  if (!(stable ? stableIdentity(expected, current) : sameIdentity(expected, current))) throw new HostFilesError('stale_object', 'file or folder changed; refresh and try again', 409);
  return current;
}

// constrain recursive manifests to one canonical lexical subtree
function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

export type HostFilesEngineOptions = {
  journalFile?: string;
  favoritesFile?: string;
  beforeStep?: (phase: string, path: string) => void|Promise<void>;
};

// use the same bounded builtin filesystem operations natively and on the host
export class HostFilesEngine implements HostFilesBackend {
  private labels?: Map<number, string>;
  private readonly journal: FileOperationJournal;
  private readonly favorites: HostFileFavoritesStore;
  private ready?: Promise<void>;
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly reads = new Set<Readable>();
  private closed = false;

  // retain one private generation and durable recovery journal
  constructor(private readonly backendGeneration: string = randomUUID(), private readonly options: HostFilesEngineOptions = {}) {
    this.journal = new FileOperationJournal(options.journalFile);
    this.favorites = new HostFileFavoritesStore(options.favoritesFile);
  }

  // expose the capability generation used by the service
  generation(): string { return this.backendGeneration; }

  // provide a deterministic failure-injection seam without changing production behavior
  private async step(phase: string, path: string, signal?: AbortSignal): Promise<void> {
    abort(signal);
    await this.options.beforeStep?.(phase, path);
    abort(signal);
  }

  // load account labels once per verified engine generation
  private async owners(): Promise<Map<number, string>> {
    this.labels ??= await ownerLabels();
    return this.labels;
  }

  // bind shutdown and caller cancellation to every actual filesystem pipeline
  private track<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    // reject requests after intake closes
    if (this.closed) return Promise.reject(new HostFilesError('bridge_unavailable', 'file backend is closed', 503));
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    // propagate an already canceled caller before entering the action
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    this.controllers.add(controller);
    const task = action(controller.signal).finally(() => {
      signal?.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return task;
  }

  // validate every prepared descendant before the first destructive write
  private async validateManifest(manifest: HostFilesTreeManifest): Promise<void> {
    const root = checkedPath(manifest.root);
    const paths = new Set<string>();
    // reject duplicate or escaping paths before checking any identity
    for (const entry of manifest.entries) {
      const path = checkedPath(entry.path);
      // accept only exact canonical descendants with an explicit root
      if (path !== entry.path || !within(root, path) || paths.has(path)) throw new HostFilesError('invalid_request', 'invalid recursive manifest', 400);
      paths.add(path);
      await requireIdentity(path, entry.identity);
    }
    // require root authority and complete child coverage
    if (!paths.has(root)) throw new HostFilesError('invalid_request', 'recursive manifest has no root', 400);
    // verify directory membership, including late additions, without following links
    for (const entry of manifest.entries) {
      // only directories have child membership
      if (entry.identity.kind !== 'directory') continue;
      const names = await readdir(entry.path);
      // refuse unprepared children before deleting or copying anything
      if (names.some(name => !paths.has(join(entry.path, name)))) throw new HostFilesError('stale_object', 'directory contents changed', 409);
    }
  }

  // capture a bounded immutable tree without following symbolic links
  private async snapshot(path: string, maxEntries: number, maxBytes: number, signal?: AbortSignal): Promise<HostFilesTreeManifest> {
    const root = checkedPath(path);
    const manifest: HostFilesTreeManifest = { root, entries: [], totalBytes: 0 };
    let metadataBytes = Buffer.byteLength(root) + 128;
    // walk one actual directory hierarchy depth-first
    const walk = async (entryPath: string, depth: number): Promise<void> => {
      abort(signal);
      // stop excessive depth or entry counts before allocation or recursion
      if (depth > 128 || manifest.entries.length >= maxEntries) throw new HostFilesError('limit_exceeded', 'recursive file limit exceeded', 413);
      const identity = await identityAt(entryPath);
      const linkTarget = identity.kind === 'symlink' ? await readlink(entryPath) : undefined;
      const entry = { path: entryPath, identity, ...(linkTarget === undefined ? {} : { linkTarget }) };
      metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      // leave bounded room for paired source and collision manifests in one control frame
      if (metadataBytes > maxManifestMetadataBytes) throw new HostFilesError('limit_exceeded', 'recursive metadata limit exceeded', 413);
      manifest.entries.push(entry);
      manifest.totalBytes += identity.kind === 'file' ? Number(identity.size) : linkTarget === undefined ? 0 : Buffer.byteLength(linkTarget);
      // enforce aggregate byte bounds and exact safe-integer arithmetic
      if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes > maxBytes) throw new HostFilesError('limit_exceeded', 'recursive byte limit exceeded', 413);
      // descend only into actual directories
      if (identity.kind === 'directory') {
        const names = (await readdir(entryPath)).sort();
        // snapshot every child before completing the directory
        for (const name of names) await walk(join(entryPath, name), depth + 1);
      }
      await requireIdentity(entryPath, identity);
    };
    await walk(root, 0);
    return manifest;
  }

  // advance a journal phase while preserving every owned path's current identity
  private async checkpoint(record: FileJournalRecord, phase: string): Promise<void> {
    record.phase = phase;
    record.updatedAt = new Date().toISOString();
    await this.journal.put(record);
    await this.step(`after-checkpoint:${phase}`, record.destination);
  }

  // capture only newly created objects and refresh intentionally changed owned parents
  private async remember(record: FileJournalRecord, path: string): Promise<void> {
    const identity = await identityAt(path);
    const index = record.owned.findIndex(item => item.path === path);
    // replace an existing owned identity after the engine's own mutation
    if (index >= 0) record.owned[index] = { path, identity };
    else record.owned.push({ path, identity });
    const parent = record.owned.find(item => item.path === dirname(path));
    // update an owned parent's legitimate child-mutation ctime
    if (parent !== undefined) parent.identity = await requireIdentity(parent.path, parent.identity, true);
  }

  // remove only known owned identities and never recursively discover cleanup targets
  private async cleanup(record: FileJournalRecord, root: string): Promise<boolean> {
    const objects = record.owned.filter(item => within(root, item.path)).sort((left, right) => right.path.length - left.path.length);
    // never treat an unrecorded surviving root as safely cleaned
    if (!objects.some(item => item.path === root) && await optionalIdentity(root) !== undefined) return false;
    try {
      // preflight every known surviving object before any cleanup removal
      for (const object of objects) {
        const current = await optionalIdentity(object.path);
        // a missing owned object is already cleaned
        if (current === undefined) continue;
        await requireIdentity(object.path, object.identity);
      }
      // unlink known children before removing their known parent directories
      for (const object of objects) {
        const current = await optionalIdentity(object.path);
        // tolerate a previously completed cleanup step only
        if (current === undefined) continue;
        await requireIdentity(object.path, object.identity, object.identity.kind === 'directory');
        // empty-only rmdir preserves any untracked or substituted child
        if (object.identity.kind === 'directory') await rmdir(object.path);
        else {
          await unlink(object.path);
          // refresh only proven hard-link aliases changed by this exact unlink
          for (const alias of record.owned.filter(item => item.path !== object.path && sameIdentity(item.identity, current))) {
            const after = await optionalIdentity(alias.path);
            // refuse edits or substitutions rather than adopting unknown changes
            if (after === undefined || !stableIdentity(current, after) || after.size !== current.size || after.mtimeNs !== current.mtimeNs || BigInt(after.nlink) !== BigInt(current.nlink) - 1n) throw new HostFilesError('stale_object', 'cleanup alias changed', 409);
            alias.identity = after;
            // retain final publication freshness after an owned backup link is removed
            if (record.published?.path === alias.path) record.published.identity = after;
          }
        }
      }
      record.owned = record.owned.filter(item => !within(root, item.path));
      return true;
    } catch { return false; }
  }

  // reserve a private backup container and quarantine an exact prepared collision
  private async quarantine(record: FileJournalRecord, destination: string, expected: HostFileIdentity, signal?: AbortSignal, prepared?: HostFilesTreeManifest): Promise<void> {
    const manifest = prepared ?? { root: destination, entries: [{ path: destination, identity: expected }], totalBytes: Number(expected.size) };
    // recursive replacement requires a fully prepared collision tree
    if (expected.kind === 'directory' && prepared === undefined) throw new HostFilesError('invalid_request', 'directory replacement requires a manifest', 400);
    await this.validateManifest(manifest);
    await this.step('before-quarantine', destination, signal);
    await requireIdentity(destination, expected);
    const container = join(dirname(destination), `${tempPrefix}backup-${randomBytes(12).toString('hex')}`);
    record.backupContainer = container;
    record.backup = join(container, 'object');
    await this.checkpoint(record, 'backup-planned');
    await mkdir(container, { mode: 0o700 });
    await this.remember(record, container);
    await this.checkpoint(record, 'backup-reserved');
    await requireIdentity(destination, expected);
    await rename(destination, record.backup);
    const after = await identityAt(record.backup);
    // preserve a raced substitution instead of recording it as engine-owned
    if (!stableIdentity(expected, after)) throw new HostFilesError('partial_failure', 'replacement changed during quarantine; recovery required', 409);
    // record every backup descendant under its relocated prefix
    const mapped: HostFilesTreeManifest = { root: record.backup, entries: [], totalBytes: manifest.totalBytes };
    // remap only the originally prepared collision descendants
    for (const entry of manifest.entries) {
      const path = join(record.backup, relative(destination, entry.path));
      const identity = await requireIdentity(path, entry.identity, path === record.backup);
      mapped.entries.push({ path, identity, ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }) });
    }
    await this.validateManifest(mapped);
    // capture full post-rename identities rather than obsolete prepared ctimes
    for (const entry of mapped.entries) record.owned.push({ path: entry.path, identity: entry.identity });
    await this.remember(record, container);
    await this.checkpoint(record, 'quarantined');
  }

  // exclusively restore a known backup without stat-then-rename overwrites
  private async restore(record: FileJournalRecord): Promise<boolean> {
    // no collision backup means nothing needs restoration
    if (record.backup === undefined) return true;
    const backup = record.owned.find(item => item.path === record.backup);
    // an unverified quarantine is intentionally preserved for operator recovery
    if (backup === undefined) return false;
    // leave a racing final object and the backup intact
    if (await optionalIdentity(record.destination) !== undefined) return false;
    try {
      await requireIdentity(backup.path, backup.identity);
      // keep the only original tree intact until its replacement is durably restored
      if (backup.identity.kind === 'directory') {
        const entries: HostFilesTreeManifest['entries'] = [];
        // preserve inert link text without discovering unrecorded backup descendants
        for (const item of record.owned.filter(item => within(backup.path, item.path))) {
          const linkTarget = item.identity.kind === 'symlink' ? await readlink(item.path) : undefined;
          await requireIdentity(item.path, item.identity);
          entries.push({ path: item.path, identity: item.identity, ...(linkTarget === undefined ? {} : { linkTarget }) });
        }
        const manifest: HostFilesTreeManifest = { root: backup.path, entries, totalBytes: entries.reduce((bytes, item) => bytes + (item.identity.kind === 'file' ? Number(item.identity.size) : 0), 0) };
        await this.validateManifest(manifest);
        record.stage = join(dirname(record.destination), `${tempPrefix}restore-${randomBytes(12).toString('hex')}`);
        await this.checkpoint(record, 'restore-stage-planned');
        const parentIdentity = await identityAt(dirname(record.destination));
        const directoryModes = await this.stage(record, manifest, record.stage);
        await this.publish(record, record.stage, record.destination, undefined, directoryModes, parentIdentity);
      }
      else if (backup.identity.kind === 'symlink') {
        await symlink(await readlink(backup.path), record.destination);
        await this.remember(record, record.destination);
        await requireIdentity(backup.path, backup.identity);
      } else {
        await link(backup.path, record.destination);
        const linked = await requireIdentity(record.destination, backup.identity, true);
        backup.identity = await requireIdentity(backup.path, linked);
        await this.remember(record, record.destination);
      }
      record.published = { path: record.destination, identity: await identityAt(record.destination) };
      await this.checkpoint(record, 'restored');
      // clean the container only after its exact backup has been restored
      if (record.backupContainer !== undefined) {
        await this.remember(record, record.backupContainer);
        const cleaned = await this.cleanup(record, record.backupContainer);
        await this.checkpoint(record, 'restore-backup-cleaned');
        return cleaned;
      }
      return true;
    } catch { return false; }
  }

  // recover only identity-proven temporary state and retain ambiguous survivors
  private async recover(): Promise<void> {
    const records = await this.journal.all();
    // reconcile every interrupted operation independently
    for (const record of records) {
      // special recovery uses persisted favorite proofs before any source removal
      if (record.kind === 'special') { await this.recoverSpecial(record); continue; }
      const stageClean = record.stage === undefined || await this.cleanup(record, record.stage);
      await this.checkpoint(record, 'recovery-stage-cleaned');
      const currentPublication = await optionalIdentity(record.destination);
      const hasPublished = record.published !== undefined && currentPublication !== undefined && sameIdentity(record.published.identity, currentPublication);
      // retain all evidence when a formerly published final object drifted
      if (record.published !== undefined && !hasPublished) { await this.checkpoint(record, 'recovery-pending'); continue; }
      let backupClean = true;
      // retain completed publications and clean only an exact obsolete backup
      if (hasPublished && record.backupContainer !== undefined) backupClean = await this.cleanup(record, record.backupContainer);
      else if (!hasPublished) {
        // rollback only journal-owned partial publications before exclusive restoration
        const destinationClean = currentPublication === undefined || await this.cleanup(record, record.destination);
        await this.checkpoint(record, 'recovery-destination-cleaned');
        backupClean = destinationClean && await this.restore(record);
      }
      // remove evidence only once all private state has been proven resolved
      if (stageClean && backupClean) { await this.step('before-recovery-journal-remove', record.destination); await this.journal.remove(record.id); }
      else await this.checkpoint(record, 'recovery-pending');
    }
  }

  // reconcile interrupted special phases using the exact all-or-none favorite store proof
  private async recoverSpecial(record: FileJournalRecord): Promise<void> {
    try {
      // unverified publications stay preserved for operator recovery
      if (record.source === undefined || record.published === undefined) return;
      const intended = record.favorites ?? [];
      const observed = await Promise.all(intended.map(async favorite => ({ intended: favorite, current: (await this.favorites.list(favorite.placeId)).find(item => item.id === favorite.favoriteId) })));
      const pending = observed.every(item => item.current?.path === item.intended.destinationPath && sameFavoriteObject(item.current.identity, record.published!.identity) && item.current.freshness?.operationId === record.id);
      const original = observed.every(item => item.current?.path === item.intended.sourcePath && sameFavoriteObject(item.current.identity, item.intended.identity) && item.current.freshness === undefined);
      const final = observed.every(item => item.current?.path === item.intended.destinationPath && sameFavoriteObject(item.current.identity, record.published!.identity) && item.current.freshness === undefined);
      const source = await optionalIdentity(record.source.path);
      // finish an already-authorized unlink only after phase-one store proof
      if (source !== undefined) {
        // no committed favorite phase means rollback preserves the original source
        if (intended.length > 0 && original && record.phase === 'linked') { await this.abortSpecial(record.id); return; }
        // mixed store state or substituted source never permits destructive recovery
        if (!pending || !sameIdentity(source, record.source.identity) || !['linked', 'source-unlink-authorized'].includes(record.phase)) return;
        await requireIdentity(record.destination, record.published.identity);
        await this.checkpoint(record, 'source-unlink-authorized');
        await requireIdentity(record.source.path, record.source.identity);
        await unlink(record.source.path);
      } else {
        // absence is expected only after a durable unlink authorization
        if (!['source-unlink-authorized', 'source-unlinked', 'backup-cleaned'].includes(record.phase) || !pending && !final) return;
      }
      const finalIdentity = await requireIdentity(record.destination, record.published.identity, true);
      record.published.identity = finalIdentity;
      await this.remember(record, record.destination);
      await this.checkpoint(record, 'source-unlinked');
      await this.favorites.rewrite(intended.map(favorite => ({ placeId: favorite.placeId, favoriteId: favorite.favoriteId, path: record.destination, identity: finalIdentity })));
      await this.finalizeSpecial(record.id);
    } catch {
      // any uncertain identity or store commit retains all remaining evidence
      await this.checkpoint(record, 'recovery-pending').catch(() => undefined);
    }
  }

  // establish recovery before accepting any new operation
  private async ensureReady(): Promise<void> {
    this.ready ??= this.recover();
    await this.ready;
  }

  // stream bounded chunks into a descriptor while enforcing exact declared bytes
  private async streamTo(source: Readable, handle: Awaited<ReturnType<typeof open>>, expectedBytes: number, signal?: AbortSignal): Promise<number> {
    let bytes = 0;
    const count = new Transform({
      // reject extra bytes before they reach disk
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        // prevent oversized uploads from consuming unbounded disk
        if (bytes > expectedBytes) done(new HostFilesError('invalid_request', 'stream exceeds declared size', 400));
        else done(null, chunk);
      }
    });
    const sink = new Writable({
      // await every descriptor write to preserve backpressure
      write(chunk: Buffer, _encoding, done) {
        void (async () => {
          let offset = 0;
          // handle short native writes without dropping bytes
          while (offset < chunk.length) {
            abort(signal);
            const written = await handle.write(chunk, offset, chunk.length - offset);
            // refuse a non-progressing descriptor
            if (written.bytesWritten === 0) throw new HostFilesError('partial_failure', 'file write made no progress', 500);
            offset += written.bytesWritten;
          }
        })().then(() => done(), error => done(error as Error));
      }
    });
    await pipeline(source, count, sink, { signal });
    // incomplete streams never qualify for publication
    if (bytes !== expectedBytes) throw new HostFilesError('invalid_request', 'stream size does not match declaration', 400);
    return bytes;
  }

  // stage one regular file through verified no-follow descriptors
  private async stageFile(record: FileJournalRecord, source: string, destination: string, expected: HostFileIdentity, signal?: AbortSignal): Promise<void> {
    await requireIdentity(source, expected);
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // require the opened object to be the prepared inode
      const sourceInfo = await input.stat({ bigint: true });
      if (!sameIdentity(expected, identityOf(sourceInfo))) throw new HostFilesError('stale_object', 'source changed before copy', 409);
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await this.remember(record, destination);
      await this.checkpoint(record, 'staging');
      await this.streamTo(input.createReadStream({ autoClose: false }), output, Number(expected.size), signal);
      // discard bytes from any source edited while streaming
      if (!sameIdentity(expected, identityOf(await input.stat({ bigint: true })))) throw new HostFilesError('stale_object', 'source changed during copy', 409);
      await requireIdentity(source, expected);
      // preserve permissions after writes without letting umask filter them
      await output.chmod(Number(sourceInfo.mode & 0o7777n));
    } finally {
      await input.close().catch(() => undefined);
      await output?.close().catch(() => undefined);
      const owned = record.owned.find(item => item.path === destination);
      // refresh only the descriptor-owned inode after our writes
      if (owned !== undefined) {
        const current = await optionalIdentity(destination);
        // preserve substitutions instead of accepting them as cleanup authority
        if (current !== undefined && stableIdentity(owned.identity, current)) owned.identity = current;
      }
    }
  }

  // retain source modes while keeping staged directories writable and private
  private async stage(record: FileJournalRecord, manifest: HostFilesTreeManifest, stage: string, signal?: AbortSignal): Promise<ReadonlyMap<string, number>> {
    const ordered = [...manifest.entries].sort((left, right) => left.path.length - right.path.length);
    const directoryModes = new Map<string, number>();
    // create parents before their frozen children
    for (const entry of ordered) {
      await this.step('before-stage-entry', entry.path, signal);
      await requireIdentity(entry.path, entry.identity);
      const destination = join(stage, relative(manifest.root, entry.path));
      // copy only regular file bytes through descriptors
      if (entry.identity.kind === 'file') await this.stageFile(record, entry.path, destination, entry.identity, signal);
      else if (entry.identity.kind === 'directory') {
        const sourceInfo = await lstat(entry.path, { bigint: true });
        // bind copied permissions to the same prepared directory
        if (!sameIdentity(entry.identity, identityOf(sourceInfo))) throw new HostFilesError('stale_object', 'source directory changed', 409);
        directoryModes.set(destination, Number(sourceInfo.mode & 0o7777n));
        await mkdir(destination, { mode: 0o700 });
        await this.remember(record, destination);
      } else if (entry.identity.kind === 'symlink') {
        const target = await readlink(entry.path);
        // link text remains bound to the prepared symlink object
        if (target !== entry.linkTarget) throw new HostFilesError('stale_object', 'symlink changed', 409);
        await symlink(target, destination);
        await this.remember(record, destination);
      } else throw new HostFilesError('unsupported_type', 'special objects cannot be copied', 422);
      await this.checkpoint(record, 'staging');
    }
    await this.validateManifest(manifest);
    await this.checkpoint(record, 'staged');
    return directoryModes;
  }

  // exclusively materialize only the already-staged known objects
  private async publish(record: FileJournalRecord, source: string, destination: string, signal?: AbortSignal, directoryModes: ReadonlyMap<string, number> = new Map(), parentIdentity?: HostFileIdentity): Promise<void> {
    await this.step('before-publish', destination, signal);
    const ownedParent = record.owned.find(item => item.path === dirname(destination));
    const expectedParent = ownedParent?.identity ?? parentIdentity;
    // refuse a redirected parent before creating any final child
    if (expectedParent?.kind !== 'directory') throw new HostFilesError('stale_object', 'destination parent identity unavailable', 409);
    await requireIdentity(dirname(destination), expectedParent, ownedParent === undefined);
    const owned = record.owned.find(item => item.path === source);
    // publication never discovers authority from an arbitrary staging path
    if (owned === undefined) throw new HostFilesError('partial_failure', 'staging identity unavailable', 500);
    await requireIdentity(source, owned.identity);
    // publish a regular file with an exclusive hard link
    if (owned.identity.kind === 'file') {
      await link(source, destination);
      const linked = await requireIdentity(destination, owned.identity, true);
      owned.identity = await requireIdentity(source, linked);
      await this.remember(record, destination);
      await this.checkpoint(record, 'publishing');
      await requireIdentity(source, owned.identity);
      await unlink(source);
      record.owned = record.owned.filter(item => item.path !== source);
      await this.remember(record, destination);
    } else if (owned.identity.kind === 'symlink') {
      await symlink(await readlink(source), destination);
      await this.remember(record, destination);
      await this.checkpoint(record, 'publishing');
      await requireIdentity(source, owned.identity);
      await unlink(source);
      record.owned = record.owned.filter(item => item.path !== source);
    } else if (owned.identity.kind === 'directory') {
      await mkdir(destination, { mode: 0o700 });
      await this.remember(record, destination);
      await this.checkpoint(record, 'publishing');
      const children = record.owned.filter(item => dirname(item.path) === source);
      // publish only recorded staged children, never a raced addition
      for (const child of children) await this.publish(record, child.path, join(destination, basename(child.path)), signal, directoryModes);
      const mode = directoryModes.get(source);
      // apply restrictive source modes only after all children are published
      if (mode !== undefined) {
        const published = record.owned.find(item => item.path === destination);
        // retain exact ownership before changing directory metadata
        if (published === undefined) throw new HostFilesError('stale_object', 'published directory identity unavailable', 409);
        await requireIdentity(destination, published.identity);
        const handle = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          // chmod only the verified directory descriptor
          if (!sameIdentity(published.identity, identityOf(await handle.stat({ bigint: true })))) throw new HostFilesError('stale_object', 'published directory changed', 409);
          await handle.chmod(mode);
        } finally { await handle.close(); }
      }
      await requireIdentity(source, owned.identity, true);
      await rmdir(source);
      record.owned = record.owned.filter(item => item.path !== source);
      await this.remember(record, destination);
    } else throw new HostFilesError('unsupported_type', 'staged object cannot be published', 422);
    const parent = record.owned.find(item => item.path === dirname(source));
    // capture our own removal's parent ctime before the next sibling
    if (parent !== undefined) parent.identity = await requireIdentity(parent.path, parent.identity, true);
    await this.checkpoint(record, 'publishing');
  }

  // delete a complete prepared tree bottom-up with fresh checks before each unlink
  private async removeManifest(manifest: HostFilesTreeManifest, signal?: AbortSignal): Promise<void> {
    await this.validateManifest(manifest);
    const expected = new Map(manifest.entries.map(entry => [entry.path, structuredClone(entry.identity)]));
    const ordered = [...manifest.entries].sort((left, right) => right.path.length - left.path.length);
    // remove frozen descendants before their parent directories
    for (const entry of ordered) {
      await this.step('before-remove', entry.path, signal);
      await requireIdentity(entry.path, expected.get(entry.path)!);
      // remove an actual directory only once it is empty
      if (entry.identity.kind === 'directory') await rmdir(entry.path);
      else await unlink(entry.path);
      const parent = expected.get(dirname(entry.path));
      // refresh only intentional parent changes between child removals
      if (parent !== undefined) expected.set(dirname(entry.path), await requireIdentity(dirname(entry.path), parent, true));
    }
  }

  // bind absent or replaced final names before the first staging write
  private async destinationCheck(destination: string, parent: HostFileIdentity, expected: HostFileIdentity | undefined, replace: boolean): Promise<void> {
    await requireIdentity(dirname(destination), parent);
    const current = await optionalIdentity(destination);
    // absence and collision identity both belong to the prepared decision
    if (expected === undefined ? current !== undefined : current === undefined || !sameIdentity(expected, current)) throw new HostFilesError('stale_object', 'destination changed; prepare again', 409);
    // existing objects require explicit replacement authority
    if (current !== undefined && !replace) throw new HostFilesError('conflict', 'destination already exists', 409);
  }

  // create a durable transaction record before touching any destination object
  private record(id: string, kind: FileJournalRecord['kind'], destination: string, source?: OwnedObject): FileJournalRecord {
    return { id, kind, phase: 'prepared', destination, owned: [], updatedAt: new Date().toISOString(), ...(source === undefined ? {} : { source }) };
  }

  // publish a complete copy and preserve the source on every failure
  private async copy(command: HostFilesCopyCommand, signal?: AbortSignal): Promise<HostFilesMutationResult> {
    const source = checkedPath(command.sourcePath);
    const destination = checkedPath(command.destinationPath);
    // reject both direct equality and directory self-descendants
    if (source === destination || command.sourceIdentity.kind === 'directory' && within(source, destination)) throw new HostFilesError('invalid_path', 'destination cannot be inside source', 400);
    await this.step('before-first-write', destination, signal);
    await requireIdentity(source, command.sourceIdentity);
    await this.validateManifest(command.sourceManifest);
    await this.destinationCheck(destination, command.destinationParentIdentity, command.destinationIdentity, command.replace);
    const record = this.record(command.operationId, 'copy', destination, { path: source, identity: command.sourceIdentity });
    record.stage = join(dirname(destination), `${tempPrefix}stage-${randomBytes(12).toString('hex')}`);
    await this.checkpoint(record, 'stage-planned');
    try {
      const directoryModes = await this.stage(record, command.sourceManifest, record.stage, signal);
      await requireIdentity(dirname(destination), command.destinationParentIdentity, true);
      // quarantine only the exact prepared collision after complete staging
      if (command.replace && command.destinationIdentity !== undefined) await this.quarantine(record, destination, command.destinationIdentity, signal, command.destinationManifest);
      await this.publish(record, record.stage, destination, signal, directoryModes, command.destinationParentIdentity);
      record.published = { path: destination, identity: await identityAt(destination) };
      await this.checkpoint(record, 'published');
      // cleanup can touch only captured backup identities
      if (record.backupContainer !== undefined && !await this.cleanup(record, record.backupContainer)) throw new HostFilesError('partial_failure', 'destination published; backup recovery required', 409);
      await this.journal.remove(record.id);
      return { bytesCompleted: command.sourceManifest.totalBytes, destinationIdentity: record.published.identity, results: [{ sourcePath: source, destinationPath: destination, outcome: 'copied' }] };
    } catch (error) {
      const stageClean = await this.cleanup(record, record.stage);
      const published = record.owned.some(item => item.path === destination);
      // incomplete publications clean only exact engine-owned children
      const destinationClean = !published || record.published !== undefined || await this.cleanup(record, destination);
      const restored = record.published !== undefined || await this.restore(record);
      // unresolved survivors retain durable evidence rather than claiming rollback
      if (stageClean && destinationClean && restored && record.published === undefined) await this.journal.remove(record.id);
      else await this.checkpoint(record, 'recovery-pending').catch(() => undefined);
      throw hostFilesError(error);
    }
  }

  // fetch one exact recovery record for a service-controlled special rename phase
  private async specialRecord(id: string): Promise<FileJournalRecord> {
    const record = (await this.journal.all()).find(record => record.id === id && record.kind === 'special');
    // phase commands cannot manufacture filesystem authority
    if (record === undefined) throw new HostFilesError('invalid_request', 'special rename phase is unavailable', 409);
    return record;
  }

  // preserve a non-directory replacement through exclusive link and verified unlink
  private async backupSpecial(record: FileJournalRecord, expected: HostFileIdentity, signal?: AbortSignal): Promise<void> {
    const destination = record.destination;
    // directory collisions use the general captured-tree quarantine scheme
    if (expected.kind === 'directory') throw new HostFilesError('invalid_request', 'directory collision requires prepared quarantine', 400);
    await requireIdentity(destination, expected);
    record.backupContainer = join(dirname(destination), `${tempPrefix}backup-${randomBytes(12).toString('hex')}`);
    record.backup = join(record.backupContainer, 'object');
    await this.checkpoint(record, 'backup-planned');
    await mkdir(record.backupContainer, { mode: 0o700 });
    await this.remember(record, record.backupContainer);
    await this.checkpoint(record, 'backup-reserved');
    await this.step('before-special-backup-link', destination, signal);
    await requireIdentity(destination, expected);
    await link(destination, record.backup);
    const backupIdentity = await requireIdentity(record.backup, expected, true);
    await requireIdentity(destination, backupIdentity);
    await this.remember(record, record.backup);
    await this.checkpoint(record, 'backup-linked');
    await this.step('before-special-destination-unlink', destination, signal);
    await requireIdentity(destination, backupIdentity);
    await unlink(destination);
    await this.remember(record, record.backup);
    await this.remember(record, record.backupContainer);
    await this.checkpoint(record, 'quarantined');
  }

  // publish a special inode while retaining its original name for favorite phase one
  private async linkSpecial(command: HostFilesLinkSpecialCommand, signal?: AbortSignal): Promise<HostFilesSpecialLinkResult> {
    const source = checkedPath(command.sourcePath);
    const destination = checkedPath(command.destinationPath);
    // restrict special relocation to a same-parent rename
    if (source === destination || dirname(source) !== dirname(destination)) throw new HostFilesError('unsupported_relocation', 'special objects can only be renamed in place', 422);
    // regular trees use the copy/favorite/remove sequence
    if (['file', 'directory', 'symlink'].includes(command.sourceIdentity.kind)) throw new HostFilesError('unsupported_type', 'object is not a special rename entry', 422);
    await this.step('before-first-write', destination, signal);
    await requireIdentity(source, command.sourceIdentity);
    await this.destinationCheck(destination, command.destinationParentIdentity, command.destinationIdentity, command.replace);
    const record = this.record(command.operationId, 'special', destination, { path: source, identity: command.sourceIdentity });
    const favorites = await this.favorites.beneath(source);
    record.favorites = favorites.filter(match => match.favorite.path === source && sameFavoriteObject(match.favorite.identity, command.sourceIdentity)).map(match => ({ placeId: match.placeId, favoriteId: match.favorite.id, sourcePath: source, destinationPath: destination, identity: match.favorite.identity }));
    await this.checkpoint(record, 'prepared');
    try {
      // reserve the explicitly authorized old destination before publishing the source
      if (command.replace && command.destinationIdentity !== undefined) {
        // directories cannot be linked into an inode backup
        if (command.destinationIdentity.kind === 'directory') await this.quarantine(record, destination, command.destinationIdentity, signal, command.destinationManifest);
        else await this.backupSpecial(record, command.destinationIdentity, signal);
        // account for our own link-count changes when both names originally shared an inode
        if (stableIdentity(command.sourceIdentity, command.destinationIdentity)) record.source!.identity = await identityAt(source);
      }
      await this.step('before-special-source-link', source, signal);
      await requireIdentity(source, record.source!.identity);
      await link(source, destination);
      const linked = await requireIdentity(destination, record.source!.identity, true);
      record.source!.identity = await requireIdentity(source, linked);
      await this.remember(record, destination);
      record.published = { path: destination, identity: linked };
      await this.checkpoint(record, 'linked');
      const backup = record.owned.find(item => item.path === record.backup);
      return { operationId: record.id, sourceIdentity: record.source!.identity, destinationIdentity: linked, ...(backup === undefined ? {} : { backup }) };
    } catch (error) {
      const restored = await this.restore(record);
      // preserve uncertain links and backup identities for recovery
      if (restored && record.published === undefined) await this.journal.remove(record.id);
      else await this.checkpoint(record, 'recovery-pending').catch(() => undefined);
      throw hostFilesError(error);
    }
  }

  // remove the original special name only after service favorite phase one committed
  private async unlinkSpecial(command: HostFilesUnlinkSpecialCommand, signal?: AbortSignal): Promise<HostFilesSpecialUnlinkResult> {
    const record = await this.specialRecord(command.operationId);
    // bind phase arguments to the stored publication rather than fresh client paths
    if (record.source?.path !== command.sourcePath || record.destination !== command.destinationPath || record.phase !== 'linked') throw new HostFilesError('invalid_request', 'special rename phase mismatch', 409);
    await this.step('before-special-source-unlink', command.sourcePath, signal);
    await requireIdentity(command.sourcePath, command.sourceIdentity);
    await requireIdentity(command.destinationPath, command.destinationIdentity);
    await this.checkpoint(record, 'source-unlink-authorized');
    await requireIdentity(command.sourcePath, command.sourceIdentity);
    await unlink(command.sourcePath);
    const finalIdentity = await requireIdentity(command.destinationPath, command.destinationIdentity, true);
    record.published = { path: command.destinationPath, identity: finalIdentity };
    await this.remember(record, command.destinationPath);
    await this.checkpoint(record, 'source-unlinked');
    return { operationId: record.id, destinationIdentity: finalIdentity };
  }

  // finalize only after the service committed the final favorite identity
  private async finalizeSpecial(id: string): Promise<HostFilesMutationResult> {
    const record = await this.specialRecord(id);
    // a partial source rename cannot be declared complete
    if (!['source-unlinked', 'backup-cleaned'].includes(record.phase) || record.published === undefined) throw new HostFilesError('partial_failure', 'special rename requires recovery', 409);
    await requireIdentity(record.destination, record.published.identity);
    // discard only exact retained replacement identities
    if (record.backupContainer !== undefined && !await this.cleanup(record, record.backupContainer)) throw new HostFilesError('partial_failure', 'special rename backup cleanup requires recovery', 409);
    record.published.identity = await requireIdentity(record.destination, record.published.identity, true);
    await this.checkpoint(record, 'backup-cleaned');
    await this.favorites.rewrite((record.favorites ?? []).map(favorite => ({ placeId: favorite.placeId, favoriteId: favorite.favoriteId, path: record.destination, identity: record.published!.identity })));
    await this.journal.remove(id);
    return { bytesCompleted: 0, destinationIdentity: record.published.identity, results: [{ sourcePath: record.source!.path, destinationPath: record.destination, outcome: 'renamed' }] };
  }

  // roll back a linked destination only while the source still has the exact same inode
  private async abortSpecial(id: string): Promise<HostFilesMutationResult> {
    const record = await this.specialRecord(id);
    // source removal makes rollback unsafe and requires favorite freshness repair
    if (record.phase !== 'linked' || record.source === undefined || record.published === undefined) throw new HostFilesError('partial_failure', 'special rename cannot be rolled back safely', 409);
    await requireIdentity(record.source.path, record.source.identity);
    await requireIdentity(record.destination, record.published.identity);
    await unlink(record.destination);
    record.source.identity = await requireIdentity(record.source.path, record.source.identity, true);
    record.owned = record.owned.filter(item => item.path !== record.destination);
    record.published = undefined;
    // restore without overwriting a new final-name object
    if (!await this.restore(record)) { await this.checkpoint(record, 'recovery-pending'); throw new HostFilesError('partial_failure', 'special rename rollback requires recovery', 409); }
    await this.journal.remove(id);
    return { bytesCompleted: 0, sourceIdentity: record.source.identity, results: [{ sourcePath: record.source.path, outcome: 'failed', code: 'partial_failure', message: 'source retained; rename rolled back' }] };
  }

  // dispatch bounded metadata and exact-identity mutation commands
  async request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>> {
    return await this.track(async active => {
      try {
        await this.ensureReady();
        // protect the in-process boundary as strictly as the broker boundary
        if (!isHostFilesCommand(command)) throw new HostFilesError('invalid_request', 'invalid filesystem command', 400);
        // keep favorite reads and mutations inside the single engine owner
        if (command.kind === 'favorites-list') return await this.favorites.list(command.placeId) as HostFilesCommandResult<T>;
        // create favorites inside the single engine owner
        if (command.kind === 'favorites-add') return await this.favorites.add(command.placeId, command.path, command.identity) as HostFilesCommandResult<T>;
        // acknowledge replacement only inside the single engine owner
        if (command.kind === 'favorites-acknowledge') return await this.favorites.acknowledge(command.placeId, command.favoriteId, command.path, command.identity) as HostFilesCommandResult<T>;
        // remove favorites inside the single engine owner
        if (command.kind === 'favorites-remove') return await this.favorites.remove(command.placeId, command.favoriteId) as HostFilesCommandResult<T>;
        // locate moved favorites inside the single engine owner
        if (command.kind === 'favorites-beneath') return await this.favorites.beneath(command.path) as HostFilesCommandResult<T>;
        // commit one atomic favorite rewrite inside the single engine owner
        if (command.kind === 'favorites-rewrite') { await this.favorites.rewrite(command.rewrites); return { ok: true } as HostFilesCommandResult<T>; }
        // return one lstat metadata row
        if (command.kind === 'inspect') return await inspect(command.path, await this.owners(), command.followSymlink) as HostFilesCommandResult<T>;
        // return a canonical host directory and sorted visible objects
        if (command.kind === 'list') {
          const path = await realpath(checkedPath(command.path));
          const directory = await identityAt(path);
          // navigation always resolves an actual directory target
          if (directory.kind !== 'directory') throw new HostFilesError('invalid_path', 'path is not a directory', 400);
          const names = (await readdir(path)).sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }) || left.localeCompare(right, 'en'));
          const entries: HostFileStat[] = [];
          let metadataBytes = Buffer.byteLength(path) + 1024;
          let metadataTruncated = false;
          let inaccessibleEntries = 0;
          // retain hidden names and cap metadata allocation
          for (const name of names.slice(0, command.maxEntries)) {
            abort(active);
            try {
              const entry = await inspect(join(path, name), await this.owners());
              metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
              // truncate rather than overflow the bounded broker result frame
              if (metadataBytes > maxManifestMetadataBytes) { metadataTruncated = true; break; }
              entries.push(entry);
            }
            catch (error) {
              // protected child metadata must not hide an otherwise readable folder
              if (error instanceof HostFilesError && error.code === 'permission_denied') { inaccessibleEntries += 1; continue; }
              // a concurrently removed entry does not hide the rest of the directory
              if (!(error instanceof HostFilesError) || error.code !== 'not_found') throw error;
            }
          }
          return { path, ...(path === '/' ? {} : { parent: dirname(path) }), directory: await requireIdentity(path, directory), entries, inaccessibleEntries, truncated: metadataTruncated || names.length > command.maxEntries } as HostFilesCommandResult<T>;
        }
        // freeze recursive identities for server-owned manifests
        if (command.kind === 'snapshot') return await this.snapshot(command.path, command.maxEntries, command.maxBytes, active) as HostFilesCommandResult<T>;
        // publish a complete source copy without deleting it
        if (command.kind === 'copy') return await this.copy(command, active) as HostFilesCommandResult<T>;
        // prohibit bypassing the service's favorite-before-removal ordering
        if (command.kind === 'move') throw new HostFilesError('invalid_request', 'move requires copy, favorite, and remove phases', 400);
        // perform special publication phases explicitly
        if (command.kind === 'link-special') return await this.linkSpecial(command, active) as HostFilesCommandResult<T>;
        if (command.kind === 'unlink-special') return await this.unlinkSpecial(command, active) as HostFilesCommandResult<T>;
        if (command.kind === 'finalize-special') return await this.finalizeSpecial(command.operationId) as HostFilesCommandResult<T>;
        if (command.kind === 'abort-special') return await this.abortSpecial(command.operationId) as HostFilesCommandResult<T>;
        // create files through the same exact-size publication path as uploads
        if (command.kind === 'create') {
          // an empty regular file shares upload collision semantics
          if (command.objectKind === 'file') {
            const result = await this.writeInternal({ kind: 'write', operationId: command.operationId, path: command.path, size: 0, destinationParentIdentity: command.parentIdentity, destinationIdentity: command.destinationIdentity, destinationManifest: command.destinationManifest, replace: command.replace }, Readable.from([]), active);
            return { bytesCompleted: 0, destinationIdentity: result.identity, results: [{ destinationPath: result.path, outcome: 'created' }] } as HostFilesCommandResult<T>;
          }
          const destination = checkedPath(command.path);
          await this.step('before-first-write', destination, active);
          await this.destinationCheck(destination, command.parentIdentity, command.destinationIdentity, command.replace);
          const record = this.record(command.operationId, 'copy', destination);
          record.stage = join(dirname(destination), `${tempPrefix}stage-${randomBytes(12).toString('hex')}`);
          await this.checkpoint(record, 'stage-planned');
          try {
            await mkdir(record.stage, { mode: 0o700 });
            await this.remember(record, record.stage);
            await this.checkpoint(record, 'staged');
            // replacing a folder still requires exact prepared collision authority
            if (command.replace && command.destinationIdentity !== undefined) await this.quarantine(record, destination, command.destinationIdentity, active, command.destinationManifest);
            await this.publish(record, record.stage, destination, active, undefined, command.parentIdentity);
            record.published = { path: destination, identity: await identityAt(destination) };
            await this.checkpoint(record, 'published');
            // retain backups when identity-safe cleanup cannot complete
            if (record.backupContainer !== undefined && !await this.cleanup(record, record.backupContainer)) throw new HostFilesError('partial_failure', 'created folder requires backup recovery', 409);
            await this.journal.remove(record.id);
            return { bytesCompleted: 0, destinationIdentity: record.published.identity, results: [{ destinationPath: destination, outcome: 'created' }] } as HostFilesCommandResult<T>;
          } catch (error) {
            await this.cleanup(record, record.stage);
            await this.restore(record);
            await this.checkpoint(record, 'recovery-pending').catch(() => undefined);
            throw error;
          }
        }
        const results: HostFilesItemResult[] = [];
        // preflight all selected trees before deleting any selected object
        for (const item of command.items) { await requireIdentity(item.path, item.identity); await this.validateManifest(item.manifest); }
        // report every top-level deletion result independently
        for (const item of command.items) {
          try { await this.removeManifest(item.manifest, active); results.push({ sourcePath: item.path, outcome: 'deleted' }); }
          catch (error) { const failure = hostFilesError(error); results.push({ sourcePath: item.path, outcome: 'failed', code: failure.code, message: failure.message }); }
        }
        return { bytesCompleted: 0, results } as HostFilesCommandResult<T>;
      } catch (error) { throw hostFilesError(error); }
    }, signal);
  }

  // open a descriptor-bound regular file rather than a token's replacement path
  async read(command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable> {
    await this.ensureReady();
    // reads must not bypass the engine intake shutdown boundary
    if (this.closed) throw new HostFilesError('bridge_unavailable', 'file backend is closed', 503);
    abort(signal);
    const selected = checkedPath(command.path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const row = await identityAt(selected);
      // require the prepared row before following an explicitly activated symlink
      if (command.identity !== undefined && !sameIdentity(command.identity, row)) throw new HostFilesError('stale_object', 'file changed', 409);
      const effective = row.kind === 'symlink' ? await realpath(selected) : selected;
      const target = row.kind === 'symlink' ? await identityAt(effective) : row;
      // never open a FIFO, socket, or device and risk blocking the host
      if (target.kind !== 'file') throw new HostFilesError('unsupported_type', 'object type cannot be read', 422);
      handle = await open(effective, constants.O_RDONLY | constants.O_NOFOLLOW);
      // final-component descriptor validation catches path replacement before open
      if (!sameIdentity(target, identityOf(await handle.stat({ bigint: true })))) throw new HostFilesError('stale_object', 'file changed before opening', 409);
      const start = command.start ?? 0;
      const length = Math.min(command.length ?? Number(target.size), Math.max(0, Number(target.size) - start));
      // represent empty ranges without an invalid negative end offset
      if (length === 0) { await handle.close(); handle = undefined; return Readable.from([]); }
      const descriptor = handle;
      const input = descriptor.createReadStream({ autoClose: false, start, end: start + length - 1, ...(signal === undefined ? {} : { signal }) });
      // keep the descriptor open until final freshness and byte-count checks finish
      const bytes = async function* (): AsyncGenerator<Buffer> {
        let count = 0;
        try {
          // expose one bounded chunk at the consumer's pace
          for await (const chunk of input) { const value = Buffer.from(chunk as Uint8Array); count += value.length; yield value; }
          // source edits cannot be reported as a complete download
          if (count !== length || !sameIdentity(target, identityOf(await descriptor.stat({ bigint: true })))) throw new HostFilesError('stale_object', 'file changed while reading', 409);
        } finally { input.destroy(); await descriptor.close().catch(() => undefined); }
      };
      const stream = Readable.from(bytes());
      const cancel = () => { input.destroy(); stream.destroy(signal?.reason instanceof Error ? signal.reason : undefined); };
      // propagate caller cancellation to both the generator and native descriptor stream
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      handle = undefined;
      this.reads.add(stream);
      // release descriptor tracking and cancellation listeners after the actual stream closes
      stream.once('close', () => { input.destroy(); void descriptor.close().catch(() => undefined); signal?.removeEventListener('abort', cancel); this.reads.delete(stream); });
      return stream;
    } catch (error) { await handle?.close().catch(() => undefined); throw hostFilesError(error); }
  }

  // stream one exact-size body into a private file before exclusive publication
  private async writeInternal(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    const destination = checkedPath(command.path);
    await this.step('before-first-write', destination, signal);
    await this.destinationCheck(destination, command.destinationParentIdentity, command.destinationIdentity, command.replace);
    const record = this.record(command.operationId, 'upload', destination);
    record.stage = join(dirname(destination), `${tempPrefix}upload-${randomBytes(12).toString('hex')}`);
    await this.checkpoint(record, 'stage-planned');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(record.stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await this.remember(record, record.stage);
      await this.checkpoint(record, 'streaming');
      const bytesWritten = await this.streamTo(source, handle, command.size, signal);
      await handle.close();
      handle = undefined;
      await this.remember(record, record.stage);
      await this.checkpoint(record, 'staged');
      await requireIdentity(dirname(destination), command.destinationParentIdentity, true);
      // an explicit Replace applies only to the freshly checked prepared destination
      if (command.replace && command.destinationIdentity !== undefined) await this.quarantine(record, destination, command.destinationIdentity, signal, command.destinationManifest);
      await this.publish(record, record.stage, destination, signal, undefined, command.destinationParentIdentity);
      record.published = { path: destination, identity: await identityAt(destination) };
      await this.checkpoint(record, 'published');
      // cleanup failures retain their journal and surface a partial result
      if (record.backupContainer !== undefined && !await this.cleanup(record, record.backupContainer)) throw new HostFilesError('partial_failure', 'upload published; backup recovery required', 409);
      await this.journal.remove(record.id);
      return { path: destination, bytesWritten, identity: record.published.identity };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const owned = record.owned.find(item => item.path === record.stage);
      // refresh our partially written descriptor inode before exact cleanup
      if (owned !== undefined) {
        const current = await optionalIdentity(owned.path);
        // do not adopt a raced replacement temporary file
        if (current !== undefined && stableIdentity(owned.identity, current)) owned.identity = current;
      }
      const cleaned = await this.cleanup(record, record.stage);
      const restored = record.published !== undefined || await this.restore(record);
      // preserve unresolved backups or partial publications for recovery
      if (cleaned && restored && record.published === undefined) await this.journal.remove(record.id);
      else await this.checkpoint(record, 'recovery-pending').catch(() => undefined);
      throw hostFilesError(error);
    }
  }

  // bind upload pipeline cancellation to both caller and engine shutdown
  async write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    return await this.track(async active => {
      try {
        await this.ensureReady();
        // validate the in-process upload contract before reading any bytes
        if (!isHostFilesWriteCommand(command)) throw new HostFilesError('invalid_request', 'invalid upload command', 400);
        return await this.writeInternal(command, source, active);
      } catch (error) { source.destroy(); throw hostFilesError(error); }
    }, signal);
  }

  // stop intake and await actual canceled host jobs rather than abandoning them
  async close(): Promise<void> {
    this.closed = true;
    // close actual read descriptors before completing shutdown
    for (const stream of this.reads) stream.destroy();
    // signal every active native mutation or upload
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }
}

// construct the builtin-only engine shared by native and broker deployments
export function createHostFilesEngine(generation?: string, options?: HostFilesEngineOptions): HostFilesBackend {
  return new HostFilesEngine(generation, options);
}
