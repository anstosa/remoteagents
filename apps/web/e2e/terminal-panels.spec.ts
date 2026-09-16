import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushExit, paneInputText } from './pane-stream-mock.js';

// Terminal panels (First-class terminal panes, Console shells): the composer's terminal icon
// picker lists a Worktree's panes, opening one adds a resizable column beside the agent, a
// focused Terminal takes typed keys while the composer stays the Agent's, closing hides the
// panel and an `exit` frame removes it, New shell creates a Console shell, storage reopens
// live panels after a reload, and an agentless Worktree can open a Terminal too.

type Pane = { paneId: string; session: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };

const agentPanes: Pane[] = [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%2', session: '$1', window: '@0', command: 'htop', path: '/worktrees/cora', title: '', agent: false },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false },
  { paneId: '%6', session: '$1', window: '@2', command: 'vim', path: '/worktrees/cora/src', title: '', agent: false },
  // a hand-split sibling of %6: same window @2, so opening %6 must disable %7 (one claim per window)
  { paneId: '%7', session: '$1', window: '@2', command: 'less', path: '/worktrees/cora/src', title: '', agent: false }
];

// A live-mutable pane set + prompt capture, so a spec can change what the panes API returns
// (a reload dropping a gone pane, a New shell appearing) between navigations. A DELETE prunes
// the ended pane and records its query, a PATCH renames one, mirroring the real panes API.
const routeApi = (page: Page, options: { panes: () => Pane[]; onShell?: () => string; prompts?: string[]; deleted?: string[]; renamed?: { paneId: string; name: string }[] } = { panes: () => agentPanes }) =>
  page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes: options.panes() } });
    if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') return route.fulfill({ status: 201, json: { paneId: options.onShell ? options.onShell() : '%9' } });
    if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'PATCH') {
      const paneId = decodeURIComponent(path.split('/').pop()!);
      const name = (request.postDataJSON() as { name: string }).name;
      options.renamed?.push({ paneId, name });
      const pane = options.panes().find(candidate => candidate.paneId === paneId);
      if (pane !== undefined) pane.name = name;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'DELETE') {
      const paneId = decodeURIComponent(path.split('/').pop()!);
      options.deleted?.push(paneId + url.search);
      const panes = options.panes();
      const index = panes.findIndex(candidate => candidate.paneId === paneId);
      if (index >= 0) panes.splice(index, 1);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/agents/agent-1/prompt' && request.method() === 'POST') { options.prompts?.push((request.postDataJSON() as { prompt: string }).prompt); return route.fulfill({ status: 204 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

const openPicker = (page: Page) => page.getByRole('button', { name: 'Open a terminal' }).click();

// measure parent and panel together after responsive footer changes settle
const expectFullSplitHeight = async (panel: Locator) => {
  // retry against one consistent browser layout
  await expect.poll(() => panel.evaluate(element => {
    const panelBox = element.getBoundingClientRect();
    const splitBox = element.parentElement!.getBoundingClientRect();
    return { top: Math.round(panelBox.y - splitBox.y), height: Math.round(panelBox.height - splitBox.height) };
  })).toEqual({ top: 0, height: 0 });
};

// preserve the accessible icon trigger across desktop and phone layouts
test('terminal picker uses a standard icon button on desktop and phone', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // check both composer layouts
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const trigger = page.getByRole('button', { name: 'Open a terminal', exact: true });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveClass(/\bicon-button\b/u);
    await expect(trigger).toHaveAttribute('title', 'Open a terminal');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveText('');
    await expect(trigger.locator('svg[aria-hidden="true"]')).toBeVisible();
    // enlarge the glyph without changing its button
    await expect(trigger.locator('svg')).toHaveCSS('width', '20px');
    await expect(trigger.locator('svg')).toHaveCSS('height', '20px');

    const more = page.getByRole('button', { name: 'More options', exact: true });
    const referenceBox = await more.boundingBox();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(referenceBox).not.toBeNull();
    expect(triggerBox!.width).toBeCloseTo(referenceBox!.width, 1);
    expect(triggerBox!.height).toBeCloseTo(referenceBox!.height, 1);
    expect(triggerBox!.width).toBeCloseTo(triggerBox!.height, 1);

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu', { name: 'Open a terminal' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menu', { name: 'Open a terminal' })).toHaveCount(0);
  }
});

test('lists panes with the agent and a claimed window disabled, and opens a column with a resizer', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker).toBeVisible();
  // the agent's own pane and a pane sharing the agent's claimed window are both disabled
  await expect(picker.getByRole('menuitem', { name: /codex/u })).toBeDisabled();
  await expect(picker.getByRole('menuitem', { name: /htop/u })).toBeDisabled();
  // a pickable Console shell reads its name
  const shell = picker.getByRole('menuitem', { name: /build/u });
  await expect(shell).toBeEnabled();

  await shell.click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell ready\r\n');
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  await expect(column.getByText('build')).toBeVisible();
  await expect(page.locator('.log-split.has-terminals')).toBeVisible();
  // a resizer sits between the agent and the new column
  await expect(page.locator('.log-split .split-resizer')).toHaveCount(1);
});

test('opening a Terminal disables the other panes sharing its window', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // %6 and %7 both live in window @2; neither is claimed yet
  await openPicker(page);
  let picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker.getByRole('menuitem', { name: /less/u })).toBeEnabled();
  await picker.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%6"]')).toBeVisible();

  // now that %6 holds window @2's claim, its sibling %7 is no longer pickable, but %5 (@1) is
  await openPicker(page);
  picker = page.getByRole('menu', { name: 'Open a terminal' });
  const sibling = picker.getByRole('menuitem', { name: /less/u });
  await expect(sibling).toBeDisabled();
  await expect(sibling).toHaveAttribute('title', 'Another terminal already uses this window');
  await expect(picker.getByRole('menuitem', { name: /build/u })).toBeEnabled();
});

test('New shell creates a Console shell and opens it as a Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const created: Pane = { paneId: '%9', session: '$1', window: '@3', role: 'shell', name: '', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false };
  const panes = [...agentPanes];
  await routeApi(page, { panes: () => panes, onShell: () => { panes.push(created); return '%9'; } });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: 'New shell' }).click();
  await seedPaneSize(page, '%9', 80, 24);
  await pushBytes(page, '%9', 'new shell\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%9"]')).toBeVisible();
});

test('a focused Terminal takes typed keys while the composer still submits to the Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const prompts: string[] = [];
  await routeApi(page, { panes: () => agentPanes, prompts });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await column.locator('.xterm-screen').click();
  await expect(column).toHaveClass(/focused/u);
  await page.keyboard.type('ls');
  await expect.poll(() => paneInputText(page, '%5')).toContain('ls');

  // the composer stays bound to the Agent
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.fill('deploy please');
  await composer.press('Enter');
  await expect.poll(() => prompts).toContain('deploy please');
});

test('closing hides the panel without ending the shell, and an exit frame removes it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  await routeApi(page, { panes: () => agentPanes, deleted });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();

  // Close hides the panel and leaves the shell running (no End request).
  await column.getByRole('button', { name: /Close terminal/u }).click();
  await expect(column).toHaveCount(0);
  expect(deleted).toEqual([]);

  // Reopen, then an exit frame closes the panel by itself.
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await pushExit(page, '%5', 'pane closed');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toHaveCount(0);
});

test('a reload reopens panels whose pane still exists and drops those that do not', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  let panes = [...agentPanes];
  await routeApi(page, { panes: () => panes });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // open two Terminals
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane')).toHaveCount(2);

  // the vim pane is gone when the page reloads
  panes = agentPanes.filter(pane => pane.paneId !== '%6');
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
  await expect(page.locator('.terminal-pane[data-panel-key="%6"]')).toHaveCount(0);
});

test('two Terminals plus the agent resize independently within the minimum width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  await expect(page.locator('.log-split .split-resizer')).toHaveCount(2);

  const widths = async () => page.evaluate(() => ({
    agent: document.querySelector('.log-output')!.getBoundingClientRect().width,
    a: document.querySelector('.terminal-pane[data-panel-key="%5"]')!.getBoundingClientRect().width,
    b: document.querySelector('.terminal-pane[data-panel-key="%6"]')!.getBoundingClientRect().width
  }));
  const before = await widths();
  // each column respects the 390px minimum
  expect(Math.min(before.agent, before.a, before.b)).toBeGreaterThanOrEqual(389);

  // drag the resizer between the agent and the first Terminal; the third column is untouched
  const resizer = page.locator('.log-split .split-resizer').first();
  const box = (await resizer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await widths();
  expect(after.agent).toBeGreaterThan(before.agent + 40);
  expect(Math.abs(after.b - before.b)).toBeLessThan(20);

  // dragging the %5|%6 divider far right cannot shrink %6 below the 390px floor
  const between = page.locator('.log-split .split-resizer').nth(1);
  const box2 = (await between.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 500, box2.y + box2.height / 2, { steps: 10 });
  await page.mouse.up();
  const clamped = await widths();
  expect(clamped.b).toBeGreaterThanOrEqual(389);
});

// cover every combination that previously left empty grid rows
for (const panels of ['note', 'browser', 'note and browser']) {
  // keep mixed desktop panels and the selected phone panel full-height
  test(`a shell with ${panels} uses the full split height`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    await installPaneMock(page);
    await routeApi(page);
    // provide a browser target alongside the existing pane fixture
    await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0, projectUrl: 'https://preview.example/', projectProxied: false }], projects: [] } }));
    // provide one saved note
    await page.route('**/api/worktrees/cora/notes', route => route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Mixed split note' }] } }));
    // avoid external navigation in the embedded browser
    await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Split preview</main>' }));
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', 'agent ready\r\n');

    // open the requested supplemental panels before the shell
    if (panels.includes('browser')) await page.getByRole('button', { name: 'Open project in split view' }).click();
    // select the saved note when this combination includes it
    if (panels.includes('note')) {
      await page.getByRole('button', { name: 'Notes (1)' }).click();
      await page.getByRole('button', { name: 'Mixed split note…', exact: true }).click();
    }
    await openPicker(page);
    await page.getByRole('menuitem', { name: /build/u }).click();
    await seedPaneSize(page, '%5', 80, 24);
    await pushBytes(page, '%5', 'shell ready\r\n');

    const split = page.locator('.log-split.has-terminals');
    const visiblePanels = split.locator(':scope > :is(.log-output, .terminal-pane, .note-pane, .browser-pane):visible');
    await expect(visiblePanels).toHaveCount(panels === 'note and browser' ? 4 : 3);
    // every desktop column fills the same available output area
    for (const panel of await visiblePanels.all()) await expectFullSplitHeight(panel);

    // remove the browser divider and its grid track together in mobile preview mode
    if (panels.includes('browser')) {
      const browser = split.locator('.browser-pane');
      const divider = split.locator('.browser-resizer');
      await browser.getByRole('button', { name: 'Use mobile viewport', exact: true }).click();
      await expect(divider).toBeHidden();
      await expect(browser).toHaveCSS('width', '390px');
      const frameBox = (await browser.locator('iframe').boundingBox())!;
      expect(frameBox.width).toBeGreaterThanOrEqual(388);
      expect(frameBox.width).toBeLessThanOrEqual(390);
      const mobileBrowserBox = (await browser.boundingBox())!;
      const mobilePreviewSplit = (await split.boundingBox())!;
      expect(mobileBrowserBox.height).toBeCloseTo(mobilePreviewSplit.height, 0);
      expect(mobileBrowserBox.x + mobileBrowserBox.width).toBeCloseTo(mobilePreviewSplit.x + mobilePreviewSplit.width, 0);

      await browser.getByRole('button', { name: 'Enter browser fullscreen' }).click();
      await expect(browser).toHaveCSS('width', '1800px');
      await browser.getByRole('button', { name: 'Exit browser fullscreen' }).click();
      await expect(browser).toHaveCSS('width', '390px');

      await browser.getByRole('button', { name: 'Use desktop viewport', exact: true }).click();
      await expect(divider).toBeVisible();
      const desktopBrowserBox = (await browser.boundingBox())!;
      expect(desktopBrowserBox.width).toBeGreaterThanOrEqual(390);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(visiblePanels).toHaveCount(1);
    await expectFullSplitHeight(split.locator('.terminal-pane:visible'));
    await page.getByRole('button', { name: 'Show agent output' }).click();
    await expect(split.locator('.log-output')).toBeVisible();
    await expectFullSplitHeight(split.locator('.log-output'));
  });
}

test('on a phone the split switcher gains a chip for the Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);

  // the newly opened Terminal is the visible phone panel; the switcher offers the agent
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  const switches = page.locator('.mobile-split-switches');
  await expect(switches).toBeVisible();
  await switches.locator('.mobile-agent-switch').click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(column).toBeHidden();
  // a Terminal chip now returns to it
  await switches.locator('.mobile-terminal-switch').click();
  await expect(column).toBeVisible();
});

test('an agentless Worktree tab can open a Terminal', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const panes: Pane[] = [{ paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
      { id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (path === '/api/worktrees/cora/launch-resolution') return route.fulfill({ json: { adapters: [] } });
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /Cora/u }).click();

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', 'shell in an agentless worktree\r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();
});

test('the picker groups hidden Console shells and reopens one when chosen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  // the Agent's panes sit under Session panes, the shell in its own Console shells group
  await expect(picker.getByText('Session panes')).toBeVisible();
  await expect(picker.getByText('Console shells')).toBeVisible();
  const shell = picker.getByRole('menuitem', { name: /build/u });
  await expect(shell).toBeEnabled();
  await shell.click();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();

  // once open it is no longer a hidden shell, so the group disappears (the picker still opens)
  await openPicker(page);
  const reopened = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(reopened.getByText('Session panes')).toBeVisible();
  await expect(reopened.getByText('Console shells')).toHaveCount(0);
});

test('only a Console shell offers a rename affordance', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  // %6 (vim) is a hand-split pane, not a Console shell — the panes API cannot rename it
  await openPicker(page);
  await page.getByRole('menuitem', { name: /vim/u }).click();
  await seedPaneSize(page, '%6', 80, 24);
  const vim = page.locator('.terminal-pane[data-panel-key="%6"]');
  await expect(vim).toBeVisible();
  await expect(vim.getByRole('button', { name: /Rename terminal/u })).toHaveCount(0);

  // a Console shell does offer it
  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]').getByRole('button', { name: /Rename terminal/u })).toBeVisible();
});

test('renaming a Console shell from its panel updates the head and the picker row', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const renamed: { paneId: string; name: string }[] = [];
  const panes = agentPanes.map(pane => ({ ...pane }));
  await routeApi(page, { panes: () => panes, renamed });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column.getByText('build')).toBeVisible();

  // rename from the panel head; the endpoint is called and the head shows the new name
  await column.getByRole('button', { name: /Rename terminal/u }).click();
  const nameField = column.getByRole('textbox', { name: /Name for terminal/u });
  await nameField.fill('deploy');
  await nameField.press('Enter');
  await expect.poll(() => renamed).toContainEqual({ paneId: '%5', name: 'deploy' });
  await expect(column.getByText('deploy')).toBeVisible();

  // closing leaves the shell running; it returns to the picker under its new name
  await column.getByRole('button', { name: /Close terminal/u }).click();
  await expect(column).toHaveCount(0);
  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  await expect(picker.getByText('Console shells')).toBeVisible();
  await expect(picker.getByRole('menuitem', { name: /deploy/u })).toBeVisible();
});

test('renaming a Console shell renames its phone chip', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  const renamed: { paneId: string; name: string }[] = [];
  const panes = agentPanes.map(pane => ({ ...pane }));
  await routeApi(page, { panes: () => panes, renamed });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();

  await column.getByRole('button', { name: /Rename terminal/u }).click();
  const nameField = column.getByRole('textbox', { name: /Name for terminal/u });
  await nameField.fill('deploy');
  await nameField.press('Enter');
  await expect.poll(() => renamed).toContainEqual({ paneId: '%5', name: 'deploy' });

  // switch away so the Terminal's chip is offered; it names the renamed shell
  const switches = page.locator('.mobile-split-switches');
  await switches.locator('.mobile-agent-switch').click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(switches.locator('.mobile-terminal-switch')).toHaveAttribute('aria-label', 'Show terminal deploy');
});

test('on a phone a visible Terminal swaps the footer to the helper keys and the agent chip restores the composer', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);

  // the newly opened Terminal is the visible phone panel; the footer is now its helper keys
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  const escKey = page.getByRole('button', { name: 'Esc' });
  await expect(escKey).toBeVisible();
  await expect(composer).toBeHidden();

  // switching back to the agent panel brings the Agent's composer back and hides the keys;
  // the switcher now offers a chip back to the Terminal (opening it added the chip)
  const switches = page.locator('.mobile-split-switches');
  await switches.locator('.mobile-agent-switch').click();
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(switches.locator('.mobile-terminal-switch')).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(escKey).toBeHidden();
});

test('on a phone the helper keys drive the visible Terminal, and the Agent pane on the agent panel', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toBeVisible();

  const esc = String.fromCharCode(27);
  // the Terminal is the visible panel, so its helper keys reach the Terminal's socket
  await page.getByRole('button', { name: 'Esc' }).click();
  await expect.poll(() => paneInputText(page, '%5')).toContain(esc);
  expect(await paneInputText(page, 'agent-1')).not.toContain(esc);

  // back on the agent panel, focusing the pane surfaces the keys and they drive the Agent
  const switches = page.locator('.mobile-split-switches');
  await switches.locator('.mobile-agent-switch').click();
  await expect(page.locator('.log-output')).toBeVisible();
  await page.locator('.log-output .xterm-screen').click();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await page.getByRole('button', { name: 'Esc' }).click();
  await expect.poll(() => paneInputText(page, 'agent-1')).toContain(esc);
});

test('on a phone a tap on a Terminal focuses its textarea', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');

  // a tap focuses xterm's hidden textarea so the soft keyboard opens on the pane
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();
  await column.locator('.xterm-screen').click();
  await expect(column.locator('.xterm-helper-textarea')).toBeFocused();

  // the focus must land synchronously inside the click handler (iOS only raises the keyboard
  // for a focus() made from the tap's own click): dispatch a click and read activeElement in
  // the same tick, with no await between, so a deferred focus would fail this.
  await column.locator('.xterm-helper-textarea').evaluate(area => area.blur());
  const focusedSynchronously = await page.evaluate(() => {
    const screen = document.querySelector('.terminal-pane[data-panel-key="%5"] .xterm-screen');
    screen?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.activeElement?.classList.contains('xterm-helper-textarea') ?? false;
  });
  expect(focusedSynchronously).toBe(true);
});

test('on a phone closing a Terminal returns to the agent panel and drops its chip', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 880 });
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  await openPicker(page);
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  const column = page.locator('.terminal-pane[data-panel-key="%5"]');
  await expect(column).toBeVisible();

  // closing the visible Terminal returns the phone view to the agent and removes its chip
  await column.getByRole('button', { name: /Close terminal/u }).click();
  await expect(column).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(page.locator('.mobile-split-switches .mobile-terminal-switch')).toHaveCount(0);
  // the composer is back now that no Terminal is the visible panel
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
});

test.describe('phone touch scrolling', () => {
  test.use({ hasTouch: true });
  test('a touch drag scrolls a Terminal\'s scrollback', async ({ page }) => {
    await page.setViewportSize({ width: 428, height: 880 });
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);

    await openPicker(page);
    await page.getByRole('menuitem', { name: /build/u }).click();
    await seedPaneSize(page, '%5', 80, 24);
    // fill well past the 24-row viewport so there is scrollback to reveal
    await pushBytes(page, '%5', Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n');

    const column = page.locator('.terminal-pane[data-panel-key="%5"]');
    await expect(column).toBeVisible();
    // following the live tail: no jump control, and the last line is on screen
    const jump = column.getByRole('button', { name: 'Jump to latest' });
    const visibleRows = () => page.evaluate(() => document.querySelector('.terminal-pane[data-panel-key="%5"] .xterm-rows')?.textContent ?? '');
    await expect(jump).toBeHidden();
    await expect.poll(visibleRows).toContain('line 119');
    const before = await visibleRows();

    // a one-finger drag downward reveals older output (the console owns touch scrolling)
    await page.evaluate(() => {
      const host = document.querySelector('.terminal-pane[data-panel-key="%5"] .streamed-terminal-host') as HTMLElement;
      const rect = host.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const at = (clientY: number) => new Touch({ identifier: 1, target: host, clientX: x, clientY, pageX: x, pageY: clientY });
      const fire = (type: string, touches: Touch[], changed: Touch[]) => host.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed }));
      const startTouch = at(y);
      fire('touchstart', [startTouch], [startTouch]);
      const movedTouch = at(y + 220);
      fire('touchmove', [movedTouch], [movedTouch]);
      fire('touchend', [], [movedTouch]);
    });

    // the scrollback moved: older rows are now on screen (rendered rows changed) and the
    // jump-to-latest control appears because the pane is no longer following the tail
    await expect.poll(visibleRows).not.toBe(before);
    await expect(jump).toBeVisible();
  });
});

test('End removes an idle Console shell silently and confirms a busy one', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  const deleted: string[] = [];
  const panes: Pane[] = [
    { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
    { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false },
    { paneId: '%8', session: '$1', window: '@4', role: 'shell', name: 'server', command: 'node', path: '/worktrees/cora', title: '', agent: false, busy: true }
  ];
  await routeApi(page, { panes: () => panes, deleted });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);

  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; void dialog.accept(); });

  await openPicker(page);
  const picker = page.getByRole('menu', { name: 'Open a terminal' });
  // an idle shell ends with no confirmation, and its row disappears
  await picker.getByRole('button', { name: 'End build' }).click();
  await expect.poll(() => deleted).toContain('%5');
  expect(dialogs).toBe(0);
  await expect(picker.getByRole('menuitem', { name: /build/u })).toHaveCount(0);

  // a busy shell asks first, then ends with confirm=1
  await picker.getByRole('button', { name: 'End server' }).click();
  await expect.poll(() => deleted).toContain('%8?confirm=1');
  expect(dialogs).toBe(1);
  await expect(picker.getByRole('menuitem', { name: /server/u })).toHaveCount(0);
});
