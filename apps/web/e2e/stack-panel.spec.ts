import { expect, test, type Page } from '@playwright/test';

type Recorded = { actions?: string[]; useActions?: string[]; openedWorktrees?: string[]; openedTerminals?: { paneId: string; name: string }[]; outputReads?: string[]; outputClears?: string[]; panelClosed?: boolean };
const read = <K extends keyof Recorded>(page: Page, key: K) => page.evaluate(name => (window as unknown as Recorded)[name], key) as Promise<Recorded[K]>;

// the stack menu beside a Stack panel it opens, as a Workspace holds them
async function workbench(page: Page, width = 900) {
  await page.goto('/');
  await page.setContent(`<link rel="stylesheet" href="/src/styles.css"><style>.workbench-panel { display: grid; width: ${width}px; height: 640px; }</style><div id="root"></div>`);
  await page.evaluate(async () => {
    const { renderStackWorkbench } = await import('/e2e/stack-panel-fixture.tsx');
    renderStackWorkbench(document.querySelector<HTMLElement>('#root')!);
  });
}
const panel = (page: Page) => page.getByRole('region', { name: 'Stack' });
const openMenu = (page: Page) => page.getByRole('button', { name: /^Stack controls/u }).click();

test('Show output in the stack menu opens the Stack panel on that process, closing the menu', async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.locator('.stack-menu [aria-label="api process"] > .stack-row').click();
  await page.getByRole('button', { name: 'Show api output', exact: true }).click();

  await expect(page.locator('.stack-menu')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.panel-header-title')).toContainText('Stack · Obsidian / testing');
  await expect(panel(page).locator('.stack-pane-item[aria-current="true"]')).toContainText('api');
  await expect(panel(page).getByRole('group', { name: 'api process' }).getByLabel('Process output')).toContainText('app:/code/app api ready');
});

test("Open Stack panel opens it on the first process, and lists this Worktree's processes apart from those it uses", async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const list = panel(page).getByRole('navigation', { name: 'Stack processes' });
  await expect(list.locator('.stack-pane-section')).toHaveText(['This worktree', 'Other worktrees']);
  await expect(list.locator('.stack-pane-item-name')).toHaveText(['sync', 'api', 'web', 'docs', 'static', 'preview']);
  await expect(list.locator('.stack-pane-item-where')).toHaveText(['Static Site / Main', '/code/elsewhere']);
  await expect(list.locator('.stack-pane-item[aria-current="true"]')).toContainText('sync');
  await expect(list.locator('.stack-process-state')).toHaveText(['running', 'running', 'exited 1', 'stopped', 'stopped', 'unknown']);

  // it opens on the first process again, whatever it showed when it closed
  await list.locator('.stack-pane-item', { hasText: 'web' }).click();
  await panel(page).getByRole('button', { name: 'Close Stack panel', exact: true }).click();
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await expect(panel(page).locator('.stack-pane-item[aria-current="true"]')).toContainText('sync');
});

test('shows Needs and Needed by always, as none when empty, and selects a process from its chip', async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const sync = panel(page).getByRole('group', { name: 'sync process' });
  await expect(sync.getByRole('group', { name: 'Needs' })).toContainText('none');
  await expect(sync.getByRole('group', { name: 'Needed by' }).getByRole('button')).toHaveText(['api']);
  await expect(sync.getByRole('group', { name: 'Uses' })).toHaveCount(0);
  await sync.getByRole('group', { name: 'Needed by' }).getByRole('button', { name: 'api' }).click();

  const api = panel(page).getByRole('group', { name: 'api process' });
  await expect(api.getByRole('group', { name: 'Needs' }).getByRole('button')).toHaveText(['sync']);
  await expect(api.getByRole('group', { name: 'Needed by' }).getByRole('button')).toHaveText(['web']);
  await expect(api.getByRole('group', { name: 'Uses' }).getByRole('button')).toHaveText(['static', 'preview']);
  await api.getByRole('group', { name: 'Uses' }).getByRole('button', { name: 'static' }).click();
  await expect(panel(page).getByRole('group', { name: 'static in Static Site / Main' })).toBeVisible();
});

test("refreshes the selected process's output, following it from the bottom until scrolled up", async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const output = panel(page).getByLabel('Process output');
  await expect(output).toContainText('request 3');
  await expect.poll(() => output.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  await output.evaluate(element => { element.scrollTop = 0; });
  await expect(output).toContainText('request 6');
  expect(await output.evaluate(element => element.scrollTop)).toBe(0);
});

test("clears the selected process's output, showing only what follows", async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const output = panel(page).getByLabel('Process output');
  await expect(output).toContainText('request 3');
  await panel(page).getByRole('button', { name: 'Clear sync output' }).click();
  // a read begun before the clear never paints the old output back
  await expect(output).not.toContainText('ready');
  expect(await read(page, 'outputClears')).toEqual(['app:/code/app sync']);
  await expect(output).toContainText(/request \d+/u);
  await expect(output).not.toContainText('compiled module');
  if (process.env.SHOT_STACK_CLEAR) await page.screenshot({ path: process.env.SHOT_STACK_CLEAR });
});

test("acts on this Worktree's process, offering Open as Terminal only while it runs", async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await panel(page).locator('.stack-pane-item', { hasText: 'web' }).click();

  const web = panel(page).getByRole('group', { name: 'web process' });
  await expect(web.getByRole('button', { name: 'Start web', exact: true })).toBeEnabled();
  await expect(web.getByRole('button', { name: 'Open as Terminal' })).toHaveCount(0);
  await web.getByRole('button', { name: 'Start web', exact: true }).click();
  await expect(web.locator('.stack-pane-detail-title .stack-process-state')).toHaveText('Starting…');
  await expect(web.getByRole('button', { name: 'Restart web', exact: true })).toBeDisabled();
  await expect(web.locator('.stack-pane-detail-title .stack-process-state')).toHaveText('running');
  await expect(web.getByRole('button', { name: 'Start web', exact: true })).toBeDisabled();

  await web.getByRole('button', { name: 'Open as Terminal' }).click();
  expect(await read(page, 'openedTerminals')).toEqual([{ paneId: '%17', name: 'web' }]);
  expect(await read(page, 'actions')).toEqual(['web start']);
});

test('acts on a used process in its own Worktree, and reads its output from there', async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();
  await panel(page).locator('.stack-pane-item', { hasText: 'static' }).click();

  const used = panel(page).getByRole('group', { name: 'static in Static Site / Main' });
  await expect(used.locator('.stack-pane-where')).toHaveText('runs in Static Site / Main');
  await expect(used.getByRole('group', { name: 'Used by' }).getByRole('button')).toHaveText(['api']);
  await expect(used.getByLabel('Process output')).toContainText('site:/code/static static ready');
  await expect(used.getByRole('button', { name: 'Open as Terminal' })).toHaveCount(0);
  await expect(used.getByRole('button', { name: 'Stop static in Static Site / Main', exact: true })).toBeDisabled();

  // a refused Start says why, until the next one is sent
  await page.evaluate(() => { (window as unknown as { failNextUse?: string }).failNextUse = 'stack operation already running'; });
  await used.getByRole('button', { name: 'Start static in Static Site / Main', exact: true }).click();
  await expect(used.getByRole('alert')).toHaveText('Start failed: stack operation already running');
  await used.getByRole('button', { name: 'Start static in Static Site / Main', exact: true }).click();
  await expect(used.getByRole('alert')).toHaveCount(0);
  await expect(used.getByRole('button', { name: 'Stop static in Static Site / Main', exact: true })).toBeEnabled();
  await used.getByRole('button', { name: 'Open Static Site / Main', exact: true }).click();
  expect(await read(page, 'useActions')).toEqual(['start site:/code/static static', 'start site:/code/static static']);
  expect(await read(page, 'openedWorktrees')).toEqual(['site:/code/static']);

  // one the console could not place has nothing to act on and no output to read
  await panel(page).locator('.stack-pane-item', { hasText: 'preview' }).click();
  const unknown = panel(page).getByRole('group', { name: 'preview in /code/elsewhere' });
  await expect(unknown.getByRole('button', { name: /^(Start|Stop|Open)/u })).toHaveCount(0);
  await expect(unknown).toContainText('its output is not available here');
  expect((await read(page, 'outputReads'))?.some(entry => entry.endsWith('preview'))).toBe(false);
});

test('starts, stops and restarts the whole stack from the header, and closes', async ({ page }) => {
  await workbench(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const header = panel(page).getByRole('toolbar', { name: 'Stack actions' });
  await header.getByRole('button', { name: 'Restart all', exact: true }).click();
  await expect(header.getByRole('button', { name: 'Stop all', exact: true })).toBeDisabled();
  await expect(header.getByRole('button', { name: 'Stop all', exact: true })).toBeEnabled();
  expect(await read(page, 'actions')).toEqual(['stack restart']);
  await header.getByRole('button', { name: 'Close Stack panel', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await read(page, 'panelClosed')).toBe(true);
});

test('stacks the list above the detail in a narrow panel', async ({ page }) => {
  await workbench(page, 400);
  await openMenu(page);
  await page.getByRole('button', { name: 'Open Stack panel', exact: true }).click();

  const list = await panel(page).getByRole('navigation', { name: 'Stack processes' }).boundingBox();
  const detail = await panel(page).getByRole('group', { name: 'sync process' }).boundingBox();
  expect(list).not.toBeNull();
  expect(detail).not.toBeNull();
  expect(detail!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
});
