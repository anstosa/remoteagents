import { expect, test } from '@playwright/test';
import { isDownloadPreparation, isFileEntry, isFilesList, isOperationResult, isPreparedOperation, isUploadAuthorization, type FileEntry } from '../src/files-panel/contracts.js';

// build one fully valid browser file entry
const validEntry = (): FileEntry => ({
  name: 'alpha.txt',
  hostPath: '/home/ubuntu/project/alpha.txt',
  kind: 'file',
  owner: { uid: 1000, label: 'ubuntu' },
  permissions: '-rw-r--r--',
  mode: 0o100644,
  modifiedAt: '2026-10-06T12:34:00.000Z',
  size: 1536,
  objectToken: 'opaque-token'
});

test('file entry guard rejects malformed server metadata', () => {
  const entry = validEntry();
  expect(isFileEntry(entry)).toBe(true);
  expect(isFileEntry({ ...entry, hostPath: 'relative/file' })).toBe(false);
  expect(isFileEntry({ ...entry, hostPath: `/${'x'.repeat(4096)}` })).toBe(false);
  expect(isFileEntry({ ...entry, objectToken: '' })).toBe(false);
  expect(isFileEntry({ ...entry, objectToken: 'x'.repeat(16_385) })).toBe(false);
  expect(isFileEntry({ ...entry, modifiedAt: 'October 6, 2026' })).toBe(false);
  expect(isFileEntry({ ...entry, size: -1 })).toBe(false);
  expect(isFileEntry({ ...entry, size: 1.5 })).toBe(false);
  expect(isFileEntry({ ...entry, symlinkTargetKind: 'device' })).toBe(false);
  expect(isFileEntry({ ...entry, favorite: { id: 'too-short', state: 'available' } })).toBe(false);
  expect(isFileEntry({ ...entry, favorite: { id: 'favorite-record-0001', state: 'unknown' } })).toBe(false);
});

test('list guard rejects invalid capabilities paths and limits', () => {
  const directoryEntry = { ...validEntry(), name: '/', hostPath: '/', kind: 'directory' as const, permissions: 'drwxr-xr-x', mode: 0o40755 };
  const list = { path: '/', destinationDirectoryToken: 'opaque-directory-token', directoryEntry, entries: [validEntry()], inaccessibleEntries: 0, truncated: false, limits: { listEntries: 10_000 } };
  expect(isFilesList(list)).toBe(true);
  expect(isFilesList({ ...list, inaccessibleEntries: 10_000 })).toBe(true);
  const { inaccessibleEntries: _inaccessibleEntries, ...withoutInaccessibleEntries } = list;
  expect(isFilesList(withoutInaccessibleEntries)).toBe(false);
  expect(isFilesList({ ...list, inaccessibleEntries: null })).toBe(false);
  const { directoryEntry: _directoryEntry, ...withoutDirectoryEntry } = list;
  expect(isFilesList(withoutDirectoryEntry)).toBe(false);
  expect(isFilesList({ ...list, path: 'relative' })).toBe(false);
  expect(isFilesList({ ...list, destinationDirectoryToken: '' })).toBe(false);
  expect(isFilesList({ ...list, directoryEntry: { ...directoryEntry, hostPath: '/elsewhere' } })).toBe(false);
  expect(isFilesList({ ...list, directoryEntry: { ...directoryEntry, kind: 'file' } })).toBe(false);
  expect(isFilesList({ ...list, inaccessibleEntries: -1 })).toBe(false);
  expect(isFilesList({ ...list, inaccessibleEntries: 1.5 })).toBe(false);
  expect(isFilesList({ ...list, inaccessibleEntries: 10_001 })).toBe(false);
  expect(isFilesList({ ...list, inaccessibleEntries: '4' })).toBe(false);
  expect(isFilesList({ ...list, limits: { listEntries: -1 } })).toBe(false);
});

test('operation guards reject negative or inconsistent progress', () => {
  const prepared = { operationId: 'operation-record-0001', kind: 'copy', totalItems: 1, conflicts: [] };
  expect(isPreparedOperation(prepared)).toBe(true);
  expect(isPreparedOperation({ ...prepared, totalItems: -1 })).toBe(false);

  const result = { ...prepared, state: 'running', phase: 'copying', completedItems: 0, bytesCompleted: 0, bytesTotal: 10, results: [] };
  expect(isOperationResult(result)).toBe(true);
  expect(isOperationResult({ ...result, completedItems: -1 })).toBe(false);
  expect(isOperationResult({ ...result, completedItems: 2 })).toBe(false);
  expect(isOperationResult({ ...result, bytesCompleted: -1 })).toBe(false);
  expect(isOperationResult({ ...result, bytesCompleted: 11 })).toBe(false);
  expect(isOperationResult({ ...result, results: [null] })).toBe(false);
  expect(isOperationResult({ ...result, results: [{ outcome: 'invented' }] })).toBe(false);
  expect(isOperationResult({ ...result, results: [{ outcome: 'failed', sourcePath: 'relative', code: 'stale_object', message: 'changed' }] })).toBe(false);
  expect(isOperationResult({ ...result, results: [{ outcome: 'failed', sourcePath: '/tmp/source', destinationPath: '/tmp/destination', code: 'x'.repeat(129), message: 'changed' }] })).toBe(false);
  expect(isOperationResult({ ...result, results: [{ outcome: 'failed', sourcePath: '/tmp/source', destinationPath: '/tmp/destination', code: 'stale_object', message: 'x'.repeat(4097) }] })).toBe(false);
  expect(isOperationResult({ ...result, results: [{ outcome: 'failed', sourcePath: '/tmp/source', destinationPath: '/tmp/destination', code: 'stale_object', message: 'changed' }] })).toBe(true);
});

test('transfer guards require bounded capabilities and same-origin tickets', () => {
  expect(isUploadAuthorization({ files: [{ clientId: 'file-0', token: 'upload-token', destinationName: 'alpha.txt' }] })).toBe(true);
  expect(isUploadAuthorization({ files: [{ clientId: 'file-0', token: '', destinationName: 'alpha.txt' }] })).toBe(false);
  expect(isUploadAuthorization({ files: [{ clientId: 'file-0', skipped: true, destinationName: 'alpha.txt' }] })).toBe(true);
  expect(isDownloadPreparation({ downloadId: 'download-record-0001', filename: 'alpha.txt', url: '/api/files/downloads/download-record-0001?ticket=one-use' })).toBe(true);
  expect(isDownloadPreparation({ downloadId: 'download-record-0001', filename: 'alpha.txt', url: 'https://elsewhere.example/download' })).toBe(false);
});
