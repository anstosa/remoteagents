import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type ChatFixture = {
  agentId: string;
  dashboard: Record<string, unknown>;
};

type LinkWindow = typeof window & { __linkClipboard: string[] };

const currentAgent: ChatFixture = {
  agentId: 'agent-current',
  dashboard: {
    generation: 1,
    agents: [{ id: 'agent-current', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'repo', worktreeLabel: 'Cora', title: 'Ready', queuedPromptCount: 0 }],
    projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'main', available: true, pinned: true, order: 0 }] }]
  }
};

const scratchAgent: ChatFixture = {
  agentId: 'agent-scratch',
  dashboard: {
    generation: 1,
    agents: [{ id: 'agent-scratch', sessionId: 'socket:$2', home: '/tmp/scratch', placeId: 'scratch:/tmp/scratch', displayLabel: '~ Scratch', title: 'Ready', queuedPromptCount: 0 }],
    projects: [],
    places: [{ id: 'scratch:/tmp/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/tmp/scratch', pinned: true }],
    scratchLaunch: { kind: 'codex', origin: 'scratch' }
  }
};

// install one deterministic clipboard
const installClipboard = (page: Page) => page.addInitScript(() => {
  const writes: string[] = [];
  const clipboard = {
    // record each copied target
    writeText: async (value: string) => { writes.push(value); }
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  Object.defineProperty(window, '__linkClipboard', { configurable: true, value: writes });
});

// mount one production agent output panel
const mountChat = async (page: Page, fixture: ChatFixture) => {
  await installPaneMock(page);
  await installClipboard(page);
  // keep target navigation inside the browser fixture
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>controlled chat link target</main>' }));
  // serve the minimum production app contract
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // route one fixture request
    switch (true) {
      case path === '/api/auth/session': return route.fulfill({ json: { csrfToken: 'link-csrf', active: true, deviceName: 'Test device' } });
      case path === '/api/dashboard': return route.fulfill({ json: fixture.dashboard });
      case path === '/api/push/public-key': return route.fulfill({ json: {} });
      case path === `/api/agents/${fixture.agentId}/tickets`: return route.fulfill({ json: { ticket: 'pane-ticket' } });
      case new RegExp(`^/api/agents/${fixture.agentId}/(?:saved-prompts|queued-prompts|prompt-history)$`, 'u').test(path): return route.fulfill({ json: { prompts: [] } });
      case path.endsWith('/notes') && request.method() === 'GET': return route.fulfill({ json: { notes: [] } });
      case path.endsWith('/panes') && request.method() === 'GET': return route.fulfill({ json: { panes: [] } });
      default: return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    }
  });
  await page.goto('/');
  await seedPaneSize(page, fixture.agentId, 62, 24);
};

// measure one production overlay in the fixed chat grid
const chatOverlayCells = async (page: Page, link: Locator) => {
  const [linkBox, screenBox] = await Promise.all([
    link.boundingBox(),
    page.getByLabel('Live log', { exact: true }).locator('.xterm-screen').boundingBox()
  ]);
  // require measured geometry
  if (linkBox === null || screenBox === null) throw new Error('chat link geometry is unavailable');
  const cellWidth = screenBox.width / 62;
  return { column: (linkBox.x - screenBox.x) / cellWidth, columns: linkBox.width / cellWidth };
};

// verify one padded chat link through the production panel
const expectChatLink = async (page: Page, fixture: ChatFixture) => {
  const uri = 'https://example.com/instance-icons/heart.svg';
  const firstFragment = 'https://';
  const lastFragment = 'example.com/instance-icons/heart.svg';
  await mountChat(page, fixture);
  await pushBytes(page, fixture.agentId, `  URL. I’m also testing the wrapped [View icon](${firstFragment}\r\n  ${lastFragment})  form from`);

  const links = page.getByLabel('Live log', { exact: true }).getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
  const firstCells = await chatOverlayCells(page, links.first());
  const lastCells = await chatOverlayCells(page, links.last());
  expect(firstCells.column).toBeCloseTo(48, 1);
  expect(firstCells.columns).toBeCloseTo(firstFragment.length, 1);
  expect(lastCells.column).toBeCloseTo(2, 1);
  expect(lastCells.columns).toBeCloseTo(lastFragment.length, 1);

  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri);
  await popup.close();

  await links.last().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Agent actions' });
  await menu.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  // wait for the asynchronous clipboard boundary
  await expect.poll(() => page.evaluate(() => (window as LinkWindow).__linkClipboard)).toEqual([uri]);
};

// cover the current worktree agent
test('current Agent chat opens and copies a padded multiline link', async ({ page }) => {
  await expectChatLink(page, currentAgent);
});

// cover the scratch agent
test('Scratch chat opens and copies a padded multiline link', async ({ page }) => {
  await expectChatLink(page, scratchAgent);
});
