import { expect, test } from '@playwright/test';
import { retainCurrentSelection, selectFileEntry, type FileSelection } from '../src/files-panel/selection.js';
import type { FileEntry } from '../src/files-panel/contracts.js';

// create one minimal current entry for pure reducer coverage
const entry = (name: string): FileEntry => ({ name, hostPath: `/tmp/${name}`, kind: 'file', owner: { uid: 1000, label: 'ubuntu' }, permissions: '-rw-r--r--', mode: 0o100644, modifiedAt: '2026-10-06T00:00:00.000Z', size: 1, objectToken: `token-${name}` });
const entries = ['alpha', 'beta', 'gamma', 'delta'].map(entry);
const empty = (): FileSelection => ({ tokens: new Set() });

test('plain desktop selection replaces and updates the range anchor', () => {
  const selected = selectFileEntry(empty(), entries[1], entries, { mobile: false, toggle: false, range: false });
  expect([...selected.tokens]).toEqual(['token-beta']);
  expect(selected.anchor).toBe('token-beta');
});

test('ctrl or command toggles without opening or clearing other rows', () => {
  const first = selectFileEntry(empty(), entries[0], entries, { mobile: false, toggle: true, range: false });
  const second = selectFileEntry(first, entries[2], entries, { mobile: false, toggle: true, range: false });
  const removed = selectFileEntry(second, entries[0], entries, { mobile: false, toggle: true, range: false });
  expect([...removed.tokens]).toEqual(['token-gamma']);
});

test('shift follows rendered order and ctrl shift adds the range', () => {
  const anchor = selectFileEntry(empty(), entries[1], entries, { mobile: false, toggle: false, range: false });
  const range = selectFileEntry(anchor, entries[3], entries, { mobile: false, toggle: false, range: true });
  expect([...range.tokens]).toEqual(['token-beta', 'token-gamma', 'token-delta']);
  const seeded = { tokens: new Set(['token-alpha']), anchor: 'token-beta' };
  const added = selectFileEntry(seeded, entries[2], entries, { mobile: false, toggle: true, range: true });
  expect([...added.tokens]).toEqual(['token-alpha', 'token-beta', 'token-gamma']);
});

test('mobile successive taps toggle multiple rows', () => {
  const first = selectFileEntry(empty(), entries[0], entries, { mobile: true, toggle: false, range: false });
  const second = selectFileEntry(first, entries[1], entries, { mobile: true, toggle: false, range: false });
  const removed = selectFileEntry(second, entries[0], entries, { mobile: true, toggle: false, range: false });
  expect([...removed.tokens]).toEqual(['token-beta']);
});

test('refresh retains exact current tokens and clears a stale anchor', () => {
  const current = { tokens: new Set(['token-alpha', 'token-gamma']), anchor: 'token-alpha' };
  const retained = retainCurrentSelection(current, [entries[2]]);
  expect([...retained.tokens]).toEqual(['token-gamma']);
  expect(retained.anchor).toBeUndefined();
});
