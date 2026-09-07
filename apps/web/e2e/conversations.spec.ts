import { expect, test } from '@playwright/test';

// require one rendered element box
function requireBounds(bounds: { x: number; y: number; width: number; height: number } | null, label: string): asserts bounds is { x: number; y: number; width: number; height: number } {
  expect(bounds, `${label} bounds`).not.toBeNull();
  if (bounds === null) throw new Error(`${label} bounds unavailable`);
}

const currentId = 'aaaaaaaa-2222-4333-8444-555555555555';
const now = Date.now();
const conversations = [
  { kind: 'claude', id: currentId, name: 'Diagnose the shell', automatic: false, lastActiveAt: now - 3_600_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, current: true },
  { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'tmux fish shell issue', automatic: true, lastActiveAt: now - 86_400_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, current: false },
  { kind: 'claude', id: 'cccccccc-2222-4333-8444-555555555555', name: 'Release plan review', automatic: false, lastActiveAt: now - 172_800_000, directory: '/worktrees/cora', worktreeId: 'cora', consoleNamed: false, current: false },
];

// stub every route the live-agent view preloads, plus the conversations list
async function mockConsole(page: import('@playwright/test').Page, onConversations?: (url: URL) => void) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/bookmarks' && request.method() === 'GET') return route.fulfill({ json: { bookmarks: [], canResume: true } });
    if (url.pathname === '/api/worktrees/cora/conversations' && request.method() === 'GET') {
      onConversations?.(url);
      return route.fulfill({ json: { conversations, canResume: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('lists named conversations in a searchable dialog on the desktop', async ({ page }) => {
  let listedWithAgent = false;
  await mockConsole(page, url => { listedWithAgent = url.searchParams.get('agentId') === 'agent-1'; });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.goto('/');

  const control = page.getByRole('button', { name: 'Conversations' });
  // the closed control counts the console-named conversations (none yet)
  await expect(control).toHaveAccessibleName('Conversations (0)');
  await control.click();
  const menu = page.locator('.conversations-menu');
  await menu.locator('.conversations-all').click();
  // the live agent is passed so the current row resolves
  await expect.poll(() => listedWithAgent).toBe(true);

  const dialog = page.locator('.conversations-dialog');
  await expect(dialog.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  // the block that applies to every row is stated once at the top
  await expect(dialog.locator('.conversations-note')).toBeVisible();
  const rows = dialog.locator('.conversation-row');
  await expect(rows).toHaveCount(3);
  // newest-active first, as the server ordered them
  await expect(rows.first()).toContainText('Diagnose the shell');
  // the current row carries the CURRENT pill and aria-current
  const currentRow = dialog.locator('.conversation-row.current');
  await expect(currentRow).toHaveAttribute('aria-current', 'true');
  await expect(currentRow.locator('.conversation-pill')).toHaveText('CURRENT');
  // an automatic title renders in italics
  const automaticRow = dialog.locator('.conversation-row.automatic');
  await expect(automaticRow).toContainText('tmux fish shell issue');
  await expect(automaticRow.locator('.conversation-copy strong')).toHaveCSS('font-style', 'italic');
  // a Claude row shows its kind glyph and relative age
  await expect(currentRow.locator('.conversation-copy small')).toContainText('Claude');

  // search narrows on the conversation name
  await dialog.getByRole('searchbox').fill('release');
  await expect(dialog.locator('.conversation-row')).toHaveCount(1);
  await expect(dialog.locator('.conversation-row')).toContainText('Release plan review');
  await dialog.getByRole('searchbox').fill('');
  await expect(dialog.locator('.conversation-row')).toHaveCount(3);

  await dialog.getByRole('button', { name: 'Close conversations' }).click();
  await expect(dialog).toBeHidden();
});

test('opens the conversations dialog full-screen on a phone', async ({ page }) => {
  await mockConsole(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Conversations' }).click();
  await page.locator('.conversations-menu').locator('.conversations-all').click();
  const surface = page.locator('.conversations-dialog > div');
  await expect(surface).toBeVisible();
  const bounds = await surface.boundingBox();
  requireBounds(bounds, 'conversations dialog');
  // full-screen: the surface spans the whole phone viewport
  expect(bounds.width).toBe(390);
  expect(bounds.x).toBe(0);
  await expect(page.locator('.conversation-row.current .conversation-pill')).toHaveText('CURRENT');
});
