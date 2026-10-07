import { expect, test, type Locator, type Page } from '@playwright/test';
import { installFilesFixture, type FilesFixture } from './files-panel-fixture.js';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type ShellFailure = 400 | 500 | 'network';
type EditorFixture = {
  fixture: FilesFixture;
  shellBodies: unknown[];
  paneReadsAfterShell: () => number;
  pageErrors: string[];
};

// return one complete dashboard with an optional configured editor
const dashboard = (editor: boolean) => ({
  generation: 1,
  editor,
  agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/home/ubuntu/project', placeId: 'cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'main', queuedPromptCount: 0 }],
  projects: []
});

// build metadata for one file outside the worktree
const outsideEntry = {
  name: 'outside.txt',
  hostPath: '/etc/outside.txt',
  kind: 'file' as const,
  owner: { uid: 0, label: 'root' },
  permissions: '-rw-r--r--',
  mode: 0o100644,
  modifiedAt: '2026-10-06T12:34:00.000Z',
  size: 128,
  objectToken: 'object-token:outside.txt:fresh-0001'
};

// install editor-aware routes over the otherwise unchanged Files fixture
async function installEditorFixture(page: Page, options: { editor?: boolean; failure?: ShellFailure; outside?: boolean; paneVisibility?: 'missing' | 'stale-once' } = {}): Promise<EditorFixture> {
  await installPaneMock(page);
  const fixture = await installFilesFixture(page);
  const shellBodies: unknown[] = [];
  const pageErrors: string[] = [];
  let paneReadsAfterShell = 0;
  const panes = [{ paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/home/ubuntu/project', title: '', agent: true }];
  // record uncaught browser failures throughout the rendered flow
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/dashboard', route => route.fulfill({ json: dashboard(options.editor !== false) }));
  await page.route('**/api/worktrees/cora/tickets', route => route.fulfill({ json: { ticket: 'editor-pane-ticket' } }));
  await page.route('**/api/worktrees/cora/panes', route => {
    // count only confirmation reads after editor creation
    if (shellBodies.length > 0) paneReadsAfterShell += 1;
    const omitEditor = options.paneVisibility === 'missing' || (options.paneVisibility === 'stale-once' && paneReadsAfterShell === 1);
    return route.fulfill({ json: { panes: omitEditor ? panes.filter(pane => pane.agent) : panes } });
  });
  await page.route('**/api/worktrees/cora/shells', async route => {
    shellBodies.push(route.request().postDataJSON());
    // simulate a transport failure before any shell exists
    if (options.failure === 'network') { await route.abort('connectionfailed'); return; }
    // return a rejected shell creation with a visible server detail
    if (options.failure !== undefined) { await route.fulfill({ status: options.failure, json: { error: `editor rejected with ${options.failure}` } }); return; }
    const paneId = `%${shellBodies.length + 8}`;
    panes.push({ paneId, session: '$editor', window: `@${shellBodies.length}`, command: 'nvim', path: '/home/ubuntu/project', title: '', agent: false, role: 'shell', name: `nvim ${shellBodies.length}` } as typeof panes[number]);
    await route.fulfill({ status: 201, json: { paneId } });
  });
  // replace only the explicitly navigated outside directory
  if (options.outside) await page.route('**/api/worktrees/cora/files/list', async route => {
    const body = route.request().postDataJSON() as { path?: string } | null;
    // preserve the shared fixture for Place-home reads
    if (body?.path !== '/etc') { await route.fallback(); return; }
    await route.fulfill({ json: {
      path: '/etc',
      parent: '/',
      destinationDirectoryToken: 'directory:/etc',
      directoryEntry: { ...outsideEntry, name: 'etc', hostPath: '/etc', kind: 'directory', permissions: 'drwxr-xr-x', mode: 0o40755, size: 4096, objectToken: 'directory-token:/etc' },
      entries: [outsideEntry],
      inaccessibleEntries: 0
    } });
  });
  return { fixture, shellBodies, paneReadsAfterShell: () => paneReadsAfterShell, pageErrors };
}

// open the rendered Files panel at either desktop or phone width
async function openFiles(page: Page, options?: Parameters<typeof installEditorFixture>[1]): Promise<EditorFixture & { panel: Locator }> {
  const state = await installEditorFixture(page, options);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  // use the phone overflow when responsive controls hide Files
  if ((page.viewportSize()?.width ?? 1280) <= 600) {
    await toolbar.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
  } else {
    await toolbar.getByRole('button', { name: 'Files', exact: true }).click();
  }
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('grid')).toBeVisible();
  return { ...state, panel };
}

// find one exact filename row without matching metadata from siblings
const fileRow = (panel: Locator, name: string) => panel.locator('.files-row').filter({ hasText: name });

test('configured editor opens an outside-worktree file from its fresh opaque capability', async ({ page }) => {
  const { fixture, panel, shellBodies, pageErrors } = await openFiles(page, { outside: true });
  // folder activation remains navigation rather than editor launch
  await panel.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(panel.getByRole('grid', { name: 'Files in /home/ubuntu/project/sub' })).toBeVisible();
  expect(shellBodies).toEqual([]);
  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(panel.getByRole('grid', { name: 'Files in /home/ubuntu/project' })).toBeVisible();

  const path = panel.getByRole('textbox', { name: 'Absolute path' });
  await path.fill('/etc');
  await path.press('Enter');
  await panel.getByRole('button', { name: 'outside.txt', exact: true }).click();
  await expect.poll(() => shellBodies.length).toBe(1);
  expect(shellBodies[0]).toEqual({ editor: true, objectToken: outsideEntry.objectToken });
  expect(JSON.stringify(shellBodies[0])).not.toContain('/etc/outside.txt');
  const terminal = page.locator('.terminal-pane[data-panel-key="%9"]');
  await expect(terminal).toBeVisible();
  await seedPaneSize(page, '%9', 80, 24);
  await pushBytes(page, '%9', 'Opened outside.txt\r\n');
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  expect(fixture.records.filter(record => record.path.endsWith('/files/preview'))).toEqual([]);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: '/tmp/remoteagents-files-editor-desktop.png', fullPage: true });
});

test('favorite activation and row-menu Open use the configured editor preference', async ({ page }) => {
  const { fixture, panel, shellBodies, pageErrors } = await openFiles(page);
  const alpha = fileRow(panel, 'alpha.txt');
  await alpha.getByRole('button', { name: 'Actions for alpha.txt' }).click();
  await page.getByRole('menu', { name: 'Actions for alpha.txt' }).getByRole('menuitem', { name: 'Add to favorites' }).click();
  await panel.getByRole('button', { name: 'Favorites' }).click();
  await page.getByRole('menu', { name: 'Favorites' }).getByRole('menuitem', { name: /alpha\.txt/u }).click();
  await expect.poll(() => shellBodies.length).toBe(1);
  expect(shellBodies[0]).toEqual({ editor: true, objectToken: 'object-token:alpha.txt:00000000' });

  const zeta = fileRow(panel, 'zeta.bin');
  await zeta.getByRole('button', { name: 'Actions for zeta.bin' }).click();
  await page.getByRole('menu', { name: 'Actions for zeta.bin' }).getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect.poll(() => shellBodies.length).toBe(2);
  expect(shellBodies[1]).toEqual({ editor: true, objectToken: 'object-token:zeta.bin:00000000' });
  expect(fixture.records.filter(record => record.path.endsWith('/files/preview'))).toEqual([]);
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('without a configured editor a filename retains the Code preview behavior', async ({ page }) => {
  const { fixture, panel, shellBodies, pageErrors } = await openFiles(page, { editor: false });
  await panel.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code.getByText('outside root preview')).toBeVisible();
  expect(shellBodies).toEqual([]);
  expect(fixture.records.find(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
  expect(pageErrors).toEqual([]);
});

test('a repeatedly missing created editor pane falls back to Code', async ({ page }) => {
  const { fixture, panel, shellBodies, paneReadsAfterShell, pageErrors } = await openFiles(page, { paneVisibility: 'missing' });
  await panel.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Code changes' }).getByText('outside root preview')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'The editor did not open; trying Code instead' })).toContainText('The editor terminal is no longer available.');
  expect(shellBodies).toEqual([{ editor: true, objectToken: 'object-token:alpha.txt:00000000' }]);
  expect(paneReadsAfterShell()).toBe(3);
  expect(fixture.records.find(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('one stale pane listing recovers into the configured editor without Code', async ({ page }) => {
  const { fixture, panel, shellBodies, paneReadsAfterShell, pageErrors } = await openFiles(page, { paneVisibility: 'stale-once' });
  await panel.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  await expect.poll(() => paneReadsAfterShell()).toBe(2);
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toBeVisible();
  expect(shellBodies).toEqual([{ editor: true, objectToken: 'object-token:alpha.txt:00000000' }]);
  expect(fixture.records.filter(record => record.path.endsWith('/files/preview'))).toEqual([]);
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// exercise each shell-creation failure class through the same visible fallback
for (const failure of [400, 500, 'network'] as const) {
  test(`editor ${failure} failure falls back to Code with feedback`, async ({ page }) => {
    const { fixture, panel, shellBodies, pageErrors } = await openFiles(page, { failure });
    await panel.getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const code = page.getByRole('region', { name: 'Code changes' });
    await expect(code.getByText('outside root preview')).toBeVisible();
    const feedback = page.getByRole('alert').filter({ hasText: 'The editor did not open; trying Code instead' });
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText(failure === 'network' ? 'Console unavailable' : `editor rejected with ${failure}`);
    expect(shellBodies).toEqual([{ editor: true, objectToken: 'object-token:alpha.txt:00000000' }]);
    expect(fixture.records.find(record => record.path.endsWith('/files/preview'))?.body).toEqual({ objectToken: 'object-token:alpha.txt:00000000' });
    expect(pageErrors).toEqual([]);
  });
}

test.describe('phone editor preference', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('configured editor terminal replaces Code as the visible file destination', async ({ page }) => {
    const { fixture, panel, shellBodies, pageErrors } = await openFiles(page);
    await panel.getByRole('button', { name: 'alpha.txt', exact: true }).tap();
    await expect.poll(() => shellBodies.length).toBe(1);
    const terminal = page.locator('.terminal-pane[data-panel-key="%9"]');
    await expect(terminal).toBeInViewport({ ratio: 0.9 });
    await seedPaneSize(page, '%9', 44, 20);
    await pushBytes(page, '%9', 'Opened alpha.txt\r\n');
    expect(shellBodies[0]).toEqual({ editor: true, objectToken: 'object-token:alpha.txt:00000000' });
    await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
    expect(fixture.records.filter(record => record.path.endsWith('/files/preview'))).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: '/tmp/remoteagents-files-editor-mobile.png', fullPage: true });
  });
});
