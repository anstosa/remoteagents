import { expect, test, type Page, type Route } from '@playwright/test';
import type { FileEntry, FilesList } from '../src/files-panel/contracts.js';

// return valid wire metadata for each explicitly selected place
function directory(placeId: string): FileEntry {
  return { name: placeId, hostPath: `/places/${placeId}`, kind: 'directory', owner: { uid: 1000, label: 'ubuntu' }, permissions: 'drwxr-xr-x', mode: 0o40755, modifiedAt: '2026-10-06T12:34:00.000Z', size: 4096, objectToken: `directory-token:${placeId}` };
}

// keep folder identities and capabilities paired across response ordering
function listing(placeId: string): FilesList {
  const entry = directory(placeId);
  return { path: entry.hostPath, parent: '/places', destinationDirectoryToken: `destination:${placeId}`, directoryEntry: entry, entries: [], inaccessibleEntries: 0 };
}

// return a distinct persisted favorite for each place
function favorites(placeId: string) {
  return { favorites: [{ id: `favorite-${placeId}-0001`, path: `/favorites/${placeId}`, state: 'unavailable' }] };
}

// replace only the network boundary with valid per-place responses
async function installRoutes(page: Page) {
  await page.route('**/api/worktrees/*/files/list', route => route.fulfill({ json: listing(new URL(route.request().url()).pathname.split('/')[3]) }));
  await page.route('**/api/worktrees/*/file-favorites', route => route.fulfill({ json: favorites(new URL(route.request().url()).pathname.split('/')[3]) }));
}

// mount one real hook under its stateful place selector
async function mount(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderFilesLifecycle } = await import('/e2e/files-controller-lifecycle-fixture.tsx');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    renderFilesLifecycle(root);
  });
  return page.getByRole('region', { name: 'Files lifecycle' });
}

test('an old-place favorite mutation cannot start a refresh after switching Place', async ({ page }) => {
  await installRoutes(page);
  const panel = await mount(page);
  await expect(panel.getByRole('textbox', { name: 'Current path' })).toHaveValue('/places/place-a');
  await expect(panel.getByRole('list', { name: 'Favorite paths' }).getByRole('listitem')).toHaveText('/favorites/place-a');
  let resolveMutation!: (route: Route) => void;
  const mutation = new Promise<Route>(resolve => { resolveMutation = resolve; });
  await page.route('**/api/worktrees/place-a/file-favorites', async route => {
    // hold only the mutation and preserve the original favorite read behavior
    if (route.request().method() !== 'PUT') return route.fallback();
    resolveMutation(route);
  });
  await panel.getByRole('button', { name: 'Favorite current folder' }).click();
  const held = await mutation;
  await panel.getByRole('button', { name: 'Switch Place' }).click();
  await expect(panel.getByRole('textbox', { name: 'Current path' })).toHaveValue('/places/place-b');
  await expect(panel.getByRole('list', { name: 'Favorite paths' }).getByRole('listitem')).toHaveText('/favorites/place-b');
  const staleRequests: string[] = [];
  // record only old-place reloads after the new place is ready
  page.on('request', request => {
    // stale callbacks must not issue old-place listing or favorite reads
    if (request.url().includes('/api/worktrees/place-a/') && request.method() !== 'PUT') staleRequests.push(request.url());
  });
  await held.fulfill({ json: { favorite: { id: 'favorite-place-a-0001' } } });
  await expect(panel.getByRole('status')).toBeVisible();
  expect(staleRequests).toEqual([]);
  await expect(panel.getByRole('textbox', { name: 'Current path' })).toHaveValue('/places/place-b');
  await expect(panel.getByRole('list', { name: 'Favorite paths' }).getByRole('listitem')).toHaveText('/favorites/place-b');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

// protect both success and failure settlements during a new-place load
for (const status of [200, 403]) {
  test(`late old-place listing ${status} and favorites cannot replace the current load`, async ({ page }) => {
    let resolveOldList!: (route: Route) => void;
    let resolveOldFavorites!: (route: Route) => void;
    let resolveNewList!: (route: Route) => void;
    const oldList = new Promise<Route>(resolve => { resolveOldList = resolve; });
    const oldFavorites = new Promise<Route>(resolve => { resolveOldFavorites = resolve; });
    const newList = new Promise<Route>(resolve => { resolveNewList = resolve; });
    await installRoutes(page);
    await page.route('**/api/worktrees/place-a/files/list', route => { resolveOldList(route); });
    await page.route('**/api/worktrees/place-a/file-favorites', route => { resolveOldFavorites(route); });
    await page.route('**/api/worktrees/place-b/files/list', route => { resolveNewList(route); });
    const panel = await mount(page);
    const heldOldList = await oldList;
    const heldOldFavorites = await oldFavorites;
    await panel.getByRole('button', { name: 'Switch Place' }).click();
    const heldNewList = await newList;
    await expect(panel.getByRole('checkbox', { name: 'Folder loading' })).toBeChecked();
    await expect(panel.getByRole('list', { name: 'Favorite paths' }).getByRole('listitem')).toHaveText('/favorites/place-b');
    const oldListResponse = page.waitForResponse(response => response.url().endsWith('/api/worktrees/place-a/files/list'));
    const oldFavoritesResponse = page.waitForResponse(response => response.url().endsWith('/api/worktrees/place-a/file-favorites'));
    await heldOldList.fulfill({ status, json: status === 200 ? listing('place-a') : { error: { code: 'permission_denied', message: 'permission denied' } } });
    await heldOldFavorites.fulfill({ json: favorites('place-a') });
    await (await oldListResponse).finished();
    await (await oldFavoritesResponse).finished();
    // allow delivered responses and their React state updates to settle
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(panel.getByRole('checkbox', { name: 'Folder loading' })).toBeChecked();
    await expect(panel.getByRole('textbox', { name: 'Current path' })).toHaveValue('');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await heldNewList.fulfill({ json: listing('place-b') });
    await expect(panel.getByRole('textbox', { name: 'Current path' })).toHaveValue('/places/place-b');
    await expect(panel.getByRole('checkbox', { name: 'Folder loading' })).not.toBeChecked();
    await expect(panel.getByRole('list', { name: 'Favorite paths' }).getByRole('listitem')).toHaveText('/favorites/place-b');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });
}
