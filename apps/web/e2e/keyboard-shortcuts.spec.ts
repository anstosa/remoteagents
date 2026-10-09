import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, paneInputText, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// The keyboard system: the C-b leader and its prefix table, send-prefix, the table timeout and
// its indicator, the bindings sheet and its ways in, the palette, terminal bindings that name
// the binding and never a command, and the y/n question before closing a panel.

type Pane = { paneId: string; session: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
const panes = (): Pane[] => [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
];

const routeApi = (page: Page, options: { keys?: unknown; shells?: unknown[]; deleted?: string[] } = {}) => page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [], ...(options.keys === undefined ? {} : { keys: options.keys }) } });
  if (path === '/api/push/public-key') return route.fulfill({ json: {} });
  if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
  if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
  if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes: panes() } });
  if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') {
    options.shells?.push(request.postDataJSON());
    return route.fulfill({ status: 201, json: { paneId: '%5' } });
  }
  if (/^\/api\/worktrees\/cora\/panes\/%25\d+$/u.test(path) && request.method() === 'DELETE') {
    options.deleted?.push(decodeURIComponent(path.split('/').pop()!) + url.search);
    return route.fulfill({ status: 204 });
  }
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

// open the dashboard with the build shell as a focused Terminal panel beside the agent
const openWithTerminal = async (page: Page, options: Parameters<typeof routeApi>[1] = {}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneMock(page);
  await page.addInitScript(() => localStorage.setItem('rac.terminals:cora', JSON.stringify([{ paneId: '%5', name: 'build' }])));
  await routeApi(page, options);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.xterm-screen').click();
  await expect(terminal).toHaveClass(/focused/u);
  return terminal;
};

const indicator = (page: Page) => page.locator('.key-indicator');

test('C-b runs a prefix key, swallows an unbound one, and C-b C-b reaches the terminal', async ({ page }) => {
  await openWithTerminal(page);

  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toHaveAccessibleName('Key table C-b');
  await expect(indicator(page)).toContainText('C-b');
  // an unbound key ends the table and goes nowhere, as in tmux
  await page.keyboard.press('q');
  await expect(indicator(page)).toHaveCount(0);

  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toHaveCount(0);
  await page.keyboard.type('ls');
  await expect.poll(() => paneInputText(page, '%5')).toContain('\u0002ls');
  expect(await paneInputText(page, '%5')).not.toContain('q');

  await page.keyboard.press('Control+b');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();
});

test('keys with no binding reach the terminal unchanged', async ({ page }) => {
  await openWithTerminal(page);
  for (const key of ['Control+a', 'Control+e', 'Control+l', 'Escape', 'Shift+ArrowLeft', 'Control+r']) await page.keyboard.press(key);
  // readline's C-a/C-e/C-l/C-r and Vim's Escape go through; Shift+Left reaches xterm with one tab
  await expect.poll(() => paneInputText(page, '%5')).toBe('\u0001\u0005\u000c\u001b\u001b[1;2D\u0012');
});

test('a table waits ten seconds, with an indicator that drains, then drops back to root', async ({ page }) => {
  await page.clock.install();
  await openWithTerminal(page);

  await page.keyboard.press('Control+b');
  await expect(indicator(page)).toBeVisible();
  const duration = await indicator(page).locator('.key-indicator-bar').evaluate(element => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeGreaterThan(9.5);
  await page.clock.fastForward(9_000);
  await expect(indicator(page)).toBeVisible();
  await page.clock.fastForward(1_100);
  await expect(indicator(page)).toHaveCount(0);
  // the expired leader no longer captures the next key
  await page.keyboard.type('c');
  await expect.poll(() => paneInputText(page, '%5')).toContain('c');
});

test('the bindings sheet opens from C-?, the toolbar and the palette, and shows where each binding came from', async ({ page }) => {
  await openWithTerminal(page, { keys: { root: { 'C-b': null, 'C-a': { table: 'prefix' }, 'C-g': { table: 'git' } }, prefix: { c: 'command-palette' }, git: { l: { terminal: 'lazygit' } } } });
  const sheet = page.getByRole('dialog', { name: 'Key bindings' });

  await page.keyboard.press('Control+?');
  await expect(sheet).toBeVisible();
  const root = sheet.getByRole('region', { name: 'root' });
  await expect(root.getByRole('row').filter({ hasText: 'C-a' })).toContainText('Config');
  const removed = root.getByRole('row').filter({ hasText: 'C-b' });
  await expect(removed).toContainText('Default, removed by config');
  await expect(removed.locator('s')).toHaveText('Switch to the prefix table');
  await expect(sheet.getByRole('region', { name: 'prefix' }).getByRole('row').filter({ hasText: 'Command palette' }).first()).toContainText('Config, replaces the default');
  await expect(sheet.getByRole('region', { name: 'git' })).toContainText('Terminal running lazygit');
  // C-? again closes it and hands focus back to the terminal
  await page.keyboard.press('Control+?');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.terminal-pane[data-panel-key="%5"]')).toHaveClass(/focused/u);

  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Key bindings' }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');

  // the removed C-b now reaches the terminal, and the configured leader opens the palette
  await page.locator('.terminal-pane[data-panel-key="%5"] .xterm-screen').click();
  await page.keyboard.press('Control+b');
  await expect.poll(() => paneInputText(page, '%5')).toContain('\u0002');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('c');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('key bindings');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(sheet).toBeVisible();
});

test('a terminal binding names the binding, never the command', async ({ page }) => {
  const shells: unknown[] = [];
  await openWithTerminal(page, { shells });
  await page.keyboard.press('Control+b');
  await page.keyboard.press('g');
  await expect.poll(() => shells).toEqual([{ binding: { table: 'prefix', key: 'g' } }]);
});

test('closing a panel asks first, and only y closes it', async ({ page }) => {
  const deleted: string[] = [];
  await openWithTerminal(page, { deleted });

  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  await expect(indicator(page)).toHaveAccessibleName('Close Terminal build?');
  await page.keyboard.press('n');
  await expect(indicator(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(deleted).toEqual([]);

  await page.keyboard.press('Control+b');
  await page.keyboard.press('x');
  await page.keyboard.press('y');
  await expect.poll(() => deleted).toEqual(['%5?confirm=1']);
});

test('prefix keys move between panels and the Workspace picker lists them', async ({ page }) => {
  const terminal = await openWithTerminal(page);
  const composer = page.getByRole('textbox', { name: 'Prompt' });

  await page.keyboard.press('Control+b');
  await page.keyboard.press('1');
  await expect(composer).toBeFocused();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('n');
  await expect(terminal).toHaveClass(/focused/u);
  await page.keyboard.press('Control+b');
  await page.keyboard.press('l');
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+b');
  await page.keyboard.press('w');
  const tree = page.getByRole('dialog', { name: 'Workspaces and panels' });
  await expect(tree.getByRole('option')).toHaveText([/Cora/u, 'Agent output', 'Terminal build']);
  await page.keyboard.type('build');
  await page.keyboard.press('Enter');
  await expect(tree).toHaveCount(0);
  await expect(terminal).toHaveClass(/focused/u);
});
