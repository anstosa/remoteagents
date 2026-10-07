// browser mirrors for authenticated host files routes
export type FileKind = 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'block' | 'character' | 'other';
export type SymlinkTargetKind = 'file' | 'directory' | 'missing' | 'inaccessible' | 'other';
export type FavoriteState = 'available' | 'modified' | 'repair-pending' | 'replaced' | 'unavailable';
export type FileEntry = {
  name: string;
  hostPath: string;
  kind: FileKind;
  symlinkTargetKind?: SymlinkTargetKind;
  owner: { uid: number; label: string };
  permissions: string;
  mode: number;
  modifiedAt: string;
  size: number;
  objectToken: string;
  favorite?: { id: string; state: FavoriteState };
};
export type Favorite = {
  id: string;
  path: string;
  state: FavoriteState;
  entry?: FileEntry;
  freshness?: { operationId: string; state: 'pending-final-ctime' };
};
export type FilesList = {
  path: string;
  parent?: string;
  destinationDirectoryToken: string;
  directoryEntry: FileEntry;
  entries: FileEntry[];
  inaccessibleEntries: number;
  favorites?: Favorite[];
  truncated?: boolean;
  limits?: Record<string, number>;
};
export type CollisionDecision = 'replace' | 'skip' | 'keep-both';
export type OperationKind = 'create-file' | 'create-folder' | 'rename' | 'copy' | 'move' | 'delete';
export type OperationConflict = { id: string; sourceName: string; destinationName: string; allowed: CollisionDecision[] };
export type PreparedOperation = { operationId: string; kind: OperationKind; totalItems: number; conflicts: OperationConflict[]; confirmation?: { names?: string[]; count?: number } | string };
export type ItemOutcome = 'created' | 'copied' | 'moved' | 'deleted' | 'renamed' | 'uploaded' | 'skipped' | 'failed';
export type ItemResult = { sourcePath?: string; destinationPath?: string; outcome: ItemOutcome; code?: string; message?: string };
export type OperationResult = { operationId: string; kind: OperationKind; state: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled'; phase: string; completedItems: number; totalItems: number; bytesCompleted: number; bytesTotal: number; results: ItemResult[] };
export type UploadPreparation = { uploadId: string; conflicts: OperationConflict[] };
export type UploadAuthorization = { files: { clientId: string; token?: string; skipped?: boolean; destinationName: string }[] };
export type DownloadPreparation = { downloadId: string; url: string; filename: string };
export type FilesError = { code: string; message: string; retryable?: boolean };

const fileKinds = new Set<FileKind>(['file', 'directory', 'symlink', 'fifo', 'socket', 'block', 'character', 'other']);
const symlinkTargetKinds = new Set<SymlinkTargetKind>(['file', 'directory', 'missing', 'inaccessible', 'other']);
const favoriteStates = new Set<FavoriteState>(['available', 'modified', 'repair-pending', 'replaced', 'unavailable']);
const operationKinds = new Set<OperationKind>(['create-file', 'create-folder', 'rename', 'copy', 'move', 'delete']);
const operationStates = new Set<OperationResult['state']>(['queued', 'running', 'completed', 'partial', 'failed', 'canceled']);
const itemOutcomes = new Set<ItemOutcome>(['created', 'copied', 'moved', 'deleted', 'renamed', 'uploaded', 'skipped', 'failed']);

// require one non-array record
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
// require one bounded absolute host path
const validPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
// require one bounded opaque capability
const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384;
// require one bounded persistent identifier
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
// require one parseable bounded server timestamp
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
// require a nonnegative safe integer
const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
// require one current favorite marker
const validFavoriteMarker = (value: unknown): boolean => {
  const candidate = record(value);
  return candidate !== undefined && validId(candidate.id) && favoriteStates.has(candidate.state as FavoriteState);
};
// validate one server-owned collision choice
const validConflict = (value: unknown): value is OperationConflict => {
  const item = record(value);
  return item !== undefined && validId(item.id) && typeof item.sourceName === 'string' && typeof item.destinationName === 'string'
    && Array.isArray(item.allowed) && item.allowed.length > 0 && item.allowed.every(choice => choice === 'replace' || choice === 'skip' || choice === 'keep-both');
};
// validate one bounded operation item before rendering its message
const validItemResult = (value: unknown): value is ItemResult => {
  const item = record(value);
  // require documented outcomes and bounded optional fields
  return item !== undefined && itemOutcomes.has(item.outcome as ItemOutcome)
    && (item.sourcePath === undefined || validPath(item.sourcePath))
    && (item.destinationPath === undefined || validPath(item.destinationPath))
    && (item.code === undefined || typeof item.code === 'string' && item.code.length > 0 && item.code.length <= 128)
    && (item.message === undefined || typeof item.message === 'string' && item.message.length <= 4096);
};

// validate one list entry before rendering server-controlled metadata
export function isFileEntry(value: unknown): value is FileEntry {
  const candidate = record(value);
  // reject incomplete entry contracts
  if (candidate === undefined || typeof candidate.name !== 'string' || candidate.name.length === 0 || new TextEncoder().encode(candidate.name).length > 255
    || !validPath(candidate.hostPath) || !fileKinds.has(candidate.kind as FileKind) || !validToken(candidate.objectToken)) return false;
  const owner = record(candidate.owner);
  return owner !== undefined && nonnegativeInteger(owner.uid) && typeof owner.label === 'string' && owner.label.length <= 256
    && typeof candidate.permissions === 'string' && candidate.permissions.length === 10 && nonnegativeInteger(candidate.mode)
    && validDate(candidate.modifiedAt) && nonnegativeInteger(candidate.size)
    && (candidate.symlinkTargetKind === undefined || symlinkTargetKinds.has(candidate.symlinkTargetKind as SymlinkTargetKind))
    && (candidate.favorite === undefined || validFavoriteMarker(candidate.favorite));
}

// validate one favorite while allowing unavailable records without an entry
export function isFavorite(value: unknown): value is Favorite {
  const candidate = record(value);
  // require the stable id, path and state
  if (candidate === undefined || !validId(candidate.id) || !validPath(candidate.path) || !favoriteStates.has(candidate.state as FavoriteState)) return false;
  const freshness = record(candidate.freshness);
  return (candidate.entry === undefined || isFileEntry(candidate.entry))
    && (candidate.freshness === undefined || freshness !== undefined && validId(freshness.operationId) && freshness.state === 'pending-final-ctime');
}

// validate a directory response as one indivisible path-token pair
export function isFilesList(value: unknown): value is FilesList {
  const candidate = record(value);
  const limits = record(candidate?.limits);
  return candidate !== undefined && validPath(candidate.path) && validToken(candidate.destinationDirectoryToken)
    && (candidate.parent === undefined || validPath(candidate.parent))
    && isFileEntry(candidate.directoryEntry) && candidate.directoryEntry.kind === 'directory' && candidate.directoryEntry.hostPath === candidate.path
    && Array.isArray(candidate.entries) && candidate.entries.length <= 10_000 && candidate.entries.every(isFileEntry)
    && nonnegativeInteger(candidate.inaccessibleEntries) && Number(candidate.inaccessibleEntries) <= 10_000
    && (candidate.favorites === undefined || Array.isArray(candidate.favorites) && candidate.favorites.every(isFavorite))
    && (candidate.truncated === undefined || typeof candidate.truncated === 'boolean')
    && (candidate.limits === undefined || limits !== undefined && Object.keys(limits).length <= 32 && Object.values(limits).every(nonnegativeInteger));
}

// validate the server-owned collision manifest
export function isPreparedOperation(value: unknown): value is PreparedOperation {
  const candidate = record(value);
  // accept only documented operation kinds
  if (candidate === undefined || !validId(candidate.operationId) || !operationKinds.has(candidate.kind as OperationKind) || !nonnegativeInteger(candidate.totalItems) || !Array.isArray(candidate.conflicts)) return false;
  return candidate.conflicts.every(validConflict);
}

// validate progress without trusting terminal state claims blindly
export function isOperationResult(value: unknown): value is OperationResult {
  const candidate = record(value);
  return candidate !== undefined && validId(candidate.operationId) && operationKinds.has(candidate.kind as OperationKind)
    && operationStates.has(candidate.state as OperationResult['state']) && typeof candidate.phase === 'string'
    && nonnegativeInteger(candidate.completedItems) && nonnegativeInteger(candidate.totalItems) && Number(candidate.completedItems) <= Number(candidate.totalItems)
    && nonnegativeInteger(candidate.bytesCompleted) && nonnegativeInteger(candidate.bytesTotal) && Number(candidate.bytesCompleted) <= Number(candidate.bytesTotal)
    && Array.isArray(candidate.results) && candidate.results.length <= Number(candidate.totalItems) && candidate.results.every(validItemResult);
}

// validate one upload preparation before rendering collision choices
export function isUploadPreparation(value: unknown): value is UploadPreparation {
  const candidate = record(value);
  return candidate !== undefined && validId(candidate.uploadId) && Array.isArray(candidate.conflicts) && candidate.conflicts.every(validConflict);
}

// validate one raw-body authorization batch
export function isUploadAuthorization(value: unknown): value is UploadAuthorization {
  const candidate = record(value);
  return candidate !== undefined && Array.isArray(candidate.files) && candidate.files.length <= 100 && candidate.files.every(value => {
    const file = record(value);
    // require one token unless the server explicitly skipped the file
    return file !== undefined && typeof file.clientId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(file.clientId)
      && typeof file.destinationName === 'string' && new TextEncoder().encode(file.destinationName).length <= 255
      && (file.skipped === true ? file.token === undefined : validToken(file.token));
  });
}

// validate one same-origin prepared download
export function isDownloadPreparation(value: unknown): value is DownloadPreparation {
  const candidate = record(value);
  return candidate !== undefined && validId(candidate.downloadId) && typeof candidate.filename === 'string' && candidate.filename.length > 0
    && typeof candidate.url === 'string' && candidate.url.startsWith(`/api/files/downloads/${encodeURIComponent(candidate.downloadId)}?`);
}

// normalize both approved and generic error envelopes
export function filesError(value: unknown, fallback: string): FilesError {
  const envelope = record(value);
  const nested = record(envelope?.error);
  // prefer the stable nested error contract
  if (nested !== undefined && typeof nested.code === 'string' && typeof nested.message === 'string') return { code: nested.code, message: nested.message, ...(typeof nested.retryable === 'boolean' ? { retryable: nested.retryable } : {}) };
  // retain compatibility with an ordinary sanitized error string
  if (typeof envelope?.error === 'string') return { code: typeof envelope.code === 'string' ? envelope.code : 'request_failed', message: envelope.error };
  return { code: 'request_failed', message: fallback };
}
