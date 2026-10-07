import { expect, test } from '@playwright/test';
import { sortFileEntries } from '../src/files-panel/controller.js';
import type { FileEntry } from '../src/files-panel/contracts.js';

// build one sortable metadata fixture
const entry = (name: string, kind: FileEntry['kind'], owner: string, permissions: string, modifiedAt: string, size: number, symlinkTargetKind?: FileEntry['symlinkTargetKind']): FileEntry => ({
  name,
  hostPath: `/tmp/${name}`,
  kind,
  owner: { uid: 1000, label: owner },
  permissions,
  mode: kind === 'directory' ? 0o40755 : 0o100644,
  modifiedAt,
  size,
  objectToken: `token-${name}`,
  ...(symlinkTargetKind === undefined ? {} : { symlinkTargetKind })
});

const entries = [
  entry('beta.txt', 'file', 'zoe', 'b', '2026-10-03T00:00:00.000Z', 300),
  entry('zed', 'directory', 'adam', 'a', '2026-10-04T00:00:00.000Z', 400),
  entry('alpha.txt', 'file', 'mary', 'a', '2026-10-01T00:00:00.000Z', 100),
  entry('docs-link', 'symlink', 'beth', 'b', '2026-10-02T00:00:00.000Z', 200, 'directory'),
  entry('archive', 'directory', 'cara', 'c', '2026-10-05T00:00:00.000Z', 500)
];

test('sorts names ascending naturally with navigable directories first', () => {
  expect(sortFileEntries(entries, { column: 'name', direction: 'ascending' }).map(candidate => candidate.name)).toEqual(['archive', 'docs-link', 'zed', 'alpha.txt', 'beta.txt']);
});

test('keeps directories first when sorting names descending', () => {
  expect(sortFileEntries(entries, { column: 'name', direction: 'descending' }).map(candidate => candidate.name)).toEqual(['zed', 'docs-link', 'archive', 'beta.txt', 'alpha.txt']);
});

test('sorts each directory and file group by owner', () => {
  expect(sortFileEntries(entries, { column: 'owner', direction: 'ascending' }).map(candidate => candidate.name)).toEqual(['zed', 'docs-link', 'archive', 'alpha.txt', 'beta.txt']);
  expect(sortFileEntries(entries, { column: 'owner', direction: 'descending' }).map(candidate => candidate.name)).toEqual(['archive', 'docs-link', 'zed', 'beta.txt', 'alpha.txt']);
});

test('sorts each directory and file group by permissions', () => {
  expect(sortFileEntries(entries, { column: 'permissions', direction: 'ascending' }).map(candidate => candidate.name)).toEqual(['zed', 'docs-link', 'archive', 'alpha.txt', 'beta.txt']);
  expect(sortFileEntries(entries, { column: 'permissions', direction: 'descending' }).map(candidate => candidate.name)).toEqual(['archive', 'docs-link', 'zed', 'beta.txt', 'alpha.txt']);
});

test('sorts each directory and file group by modified time', () => {
  expect(sortFileEntries(entries, { column: 'modified', direction: 'ascending' }).map(candidate => candidate.name)).toEqual(['docs-link', 'zed', 'archive', 'alpha.txt', 'beta.txt']);
  expect(sortFileEntries(entries, { column: 'modified', direction: 'descending' }).map(candidate => candidate.name)).toEqual(['archive', 'zed', 'docs-link', 'beta.txt', 'alpha.txt']);
});

test('sorts each directory and file group by byte size without mutating input', () => {
  const original = [...entries];
  expect(sortFileEntries(entries, { column: 'size', direction: 'ascending' }).map(candidate => candidate.name)).toEqual(['docs-link', 'zed', 'archive', 'alpha.txt', 'beta.txt']);
  expect(sortFileEntries(entries, { column: 'size', direction: 'descending' }).map(candidate => candidate.name)).toEqual(['archive', 'zed', 'docs-link', 'beta.txt', 'alpha.txt']);
  expect(entries).toEqual(original);
});
