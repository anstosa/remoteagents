import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';
import { installFilesFixture } from './files-panel-fixture.js';

// open one authenticated worktree files fixture
async function openFiles(page: Page) {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('grid')).toBeVisible();
  return { fixture, panel };
}

test('browses host paths, exposes metadata, selects rows and opens only file names', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const rows = panel.locator('.files-row');
  await expect(rows).toHaveCount(4);
  // directories sort above hidden and ordinary files
  await expect(rows.nth(0).getByRole('button', { name: 'sub', exact: true })).toBeVisible();
  await expect(rows.nth(1).getByRole('button', { name: '.hidden', exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('ubuntu');
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('-rw-r--r--');
  await expect(rows.filter({ hasText: 'alpha.txt' })).toContainText('1.5 KB');

  // row bodies select without previewing
  const hidden = rows.filter({ hasText: '.hidden' });
  await hidden.locator('[role="gridcell"][data-label="Owner"]').click();
  await expect(hidden).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  const alpha = rows.filter({ hasText: 'alpha.txt' });
  await alpha.locator('[role="gridcell"][data-label="Owner"]').click({ modifiers: ['Control'] });
  await expect(alpha).toHaveAttribute('aria-selected', 'true');

  // an unmodified file-name click sends only its object token to the separate host preview route
  await alpha.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code.getByRole('button', { name: '‹ Files' })).toBeVisible();
  await expect(code.getByText('outside root preview')).toBeVisible();
  expect(fixture.records.find(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
  await code.getByRole('button', { name: '‹ Files' }).click();
  await expect(panel).toBeVisible();

  // one header path control replaces the title, breadcrumb and duplicate form
  const path = panel.getByRole('textbox', { name: 'Absolute path' });
  await expect(path).toHaveCount(1);
  await expect(path).toHaveValue('/home/ubuntu/project');
  await expect(panel.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0);
  await expect(panel.locator('.files-breadcrumbs, .files-location, .files-toolbar, .files-favorites')).toHaveCount(0);
  const headerActions = panel.getByRole('toolbar', { name: 'Files actions' }).getByRole('button');
  await expect(headerActions.first()).toHaveAccessibleName('Go to parent folder');

  // folder-name activation and the leading parent action preserve place identity
  await panel.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(panel.getByRole('grid', { name: 'Files in /home/ubuntu/project/sub' })).toBeVisible();
  expect(fixture.currentPath()).toBe('/home/ubuntu/project/sub');
  await expect(path).toHaveValue('/home/ubuntu/project/sub');
  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(rows).toHaveCount(4);

  // Enter navigates the editable header path outside the worktree
  await path.fill('/etc');
  await path.press('Enter');
  await expect(panel.getByRole('grid', { name: 'Files in /etc' })).toBeVisible();
  await expect(path).toHaveValue('/etc');
  expect(fixture.records.findLast(record => record.path.endsWith('/files/list'))?.body).toEqual({ path: '/etc' });
});

test('creates from the New flyout with destination tokens and explicit collision choices', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  await panel.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menu', { name: 'New file or folder' }).getByRole('menuitem', { name: 'New file', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create file' });
  await create.getByRole('textbox', { name: 'Name' }).fill('existing.txt');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  const collision = page.getByRole('dialog', { name: 'Resolve name conflicts' });
  await expect(collision.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await collision.getByLabel('Keep both').check();
  await collision.getByRole('button', { name: 'Continue' }).click();
  await expect(collision).toHaveCount(0);
  const prepared = fixture.records.find(record => record.path.endsWith('/operations/prepare') && (record.body as { kind?: string }).kind === 'create-file');
  expect(prepared?.body).toEqual({ kind: 'create-file', name: 'existing.txt', destinationDirectoryToken: 'directory:/home/ubuntu/project' });
  const execute = fixture.records.find(record => record.path.endsWith('/execute'));
  expect(execute?.body).toEqual({ decisions: { 'collision-record-0001': 'keep-both' } });
});

test('uploads raw bytes, favorites per Place and downloads through the prepared ticket', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const favoriteReadsBeforeUpload = fixture.records.filter(record => record.path.endsWith('/file-favorites') && record.method === 'GET').length;
  await expect(panel.getByRole('button', { name: 'Upload files' })).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Upload files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'raw.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 1, 2]) });
  await expect(panel.getByText('Uploaded 1 file.')).toBeVisible();
  const uploadPrepare = fixture.records.find(record => record.path.endsWith('/uploads/prepare'));
  expect(uploadPrepare?.body).toEqual({ destinationDirectoryToken: 'directory:/home/ubuntu/project', files: [{ clientId: 'file-0', name: 'raw.bin', size: 4 }] });
  const raw = fixture.records.find(record => record.path.endsWith('/uploads/upload-record-0001/file-0'));
  expect(raw?.headers['x-files-upload-token']).toBe('upload-token');
  expect([...raw!.bytes!]).toEqual([0, 255, 1, 2]);
  expect(fixture.records.filter(record => record.path.endsWith('/file-favorites') && record.method === 'GET').length).toBeGreaterThan(favoriteReadsBeforeUpload);

  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  const favoritePut = fixture.records.find(record => record.path === '/api/worktrees/cora/file-favorites' && record.method === 'PUT');
  expect(favoritePut?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });

  const downloadPromise = page.waitForEvent('download');
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('alpha.txt');
  await expect(panel.getByText('Downloaded alpha.txt.')).toBeVisible();
  expect(fixture.records.find(record => record.path.endsWith('/files/downloads') && record.method === 'POST')?.body).toEqual({ objectTokens: ['object-token:alpha.txt:00000000'] });
});

test('keeps a newer favorite mutation when the initial read finishes late', async ({ page }) => {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  const delayed = fixture.holdNextFavoriteRead();
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files' }).click();
  await delayed.started;
  const panel = page.getByRole('region', { name: 'Files' });
  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(alpha.getByLabel('Favorite: available')).toBeVisible();
  delayed.release();
  await delayed.finished;
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await expect(page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /alpha\.txt/u })).toBeVisible();
});

test('refreshes rewritten favorites after rename and surfaces a later refresh failure separately', async ({ page }) => {
  const { fixture, panel } = await openFiles(page);
  const alpha = panel.locator('.files-row').filter({ hasText: 'alpha.txt' });
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await expect(alpha.getByLabel('Favorite: available')).toBeVisible();

  // rename one favorite and require its server-rewritten menu entry
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Rename' }).click();
  const renameAlpha = page.getByRole('dialog', { name: 'Rename alpha.txt' });
  await renameAlpha.getByRole('textbox', { name: 'Name' }).fill('renamed.txt');
  await renameAlpha.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(panel.getByText('1 of 1 items completed.')).toBeVisible();
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await expect(page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /renamed\.txt/u })).toBeVisible();
  await page.keyboard.press('Escape');

  // keep the successful operation result while exposing an invalid refresh
  fixture.queueFavoriteRead({ json: { favorites: [null] } });
  const zeta = panel.locator('.files-row').filter({ hasText: 'zeta.bin' });
  await zeta.getByRole('button', { name: 'Actions for zeta.bin' }).click();
  await page.getByRole('menu', { name: 'Actions for zeta.bin' }).getByRole('menuitem', { name: 'Rename' }).click();
  const renameZeta = page.getByRole('dialog', { name: 'Rename zeta.bin' });
  await renameZeta.getByRole('textbox', { name: 'Name' }).fill('renamed-zeta.bin');
  await renameZeta.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(panel.getByText('1 of 1 items completed.')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveText('The favorites response was invalid.');

  // retry both listing and favorites through the folded header action
  await page.setViewportSize({ width: 900, height: 720 });
  const actions = panel.getByRole('toolbar', { name: 'Files actions' });
  await actions.getByRole('button', { name: 'More files actions' }).click();
  await page.getByRole('group', { name: 'More files actions' }).getByRole('button', { name: 'Refresh files' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /renamed\.txt/u }).click();
  await expect(page.getByRole('region', { name: 'Code changes' }).getByText('outside root preview')).toBeVisible();
  expect(fixture.records.findLast(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:renamed.txt:00000000' });
});
