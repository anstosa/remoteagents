import { expect, test, type Page } from '@playwright/test';
import type { FileEntry } from '../src/files-panel/contracts.js';
import { installFilesFixture } from './files-panel-fixture.js';
import { installPaneMock } from './pane-stream-mock.js';

// build one readable directory response with omitted child metadata
async function openPermissionLimitedFolder(page: Page, inaccessibleEntries: number, entries: FileEntry[]) {
  await installPaneMock(page);
  await installFilesFixture(page);
  const directoryEntry: FileEntry = {
    name: 'c',
    hostPath: '/mnt/c',
    kind: 'directory',
    owner: { uid: 0, label: 'root' },
    permissions: 'drwxr-xr-x',
    mode: 0o40755,
    modifiedAt: '2026-10-06T12:34:00.000Z',
    size: 4096,
    objectToken: 'directory-token:/mnt/c'
  };
  await page.route('**/api/worktrees/cora/files/list', route => route.fulfill({ json: {
    path: '/mnt/c',
    parent: '/mnt',
    destinationDirectoryToken: 'directory:/mnt/c',
    directoryEntry,
    entries,
    inaccessibleEntries
  } }));
  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('grid', { name: 'Files in /mnt/c' })).toBeVisible();
  return panel;
}

test('reports inaccessible children while retaining readable entries', async ({ page }) => {
  const readable: FileEntry = {
    name: 'Users',
    hostPath: '/mnt/c/Users',
    kind: 'directory',
    owner: { uid: 0, label: 'root' },
    permissions: 'drwxr-xr-x',
    mode: 0o40755,
    modifiedAt: '2026-10-06T12:34:00.000Z',
    size: 4096,
    objectToken: 'directory-token:/mnt/c/Users'
  };
  const panel = await openPermissionLimitedFolder(page, 4, [readable]);
  await expect(panel.getByRole('status')).toHaveText('4 items hidden because permission was denied.');
  await expect(panel.getByRole('button', { name: 'Users', exact: true })).toBeVisible();
});

test('does not call an all-inaccessible folder empty', async ({ page }) => {
  const panel = await openPermissionLimitedFolder(page, 1, []);
  await expect(panel.getByRole('status')).toHaveText('1 item hidden because permission was denied.');
  await expect(panel.getByText('No accessible items to show.')).toBeVisible();
  await expect(panel.getByText('This folder is empty.')).toHaveCount(0);
});
