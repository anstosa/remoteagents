import { expect, test } from '@playwright/test';

// stub a controlled console whose dashboard carries the given adapter capabilities
async function openSettings(page: import('@playwright/test').Page, adapters: unknown) {
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'adapter-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

test('shows an AGENTS card per configured kind and the Codex accounts section', async ({ page }) => {
  const settingsPage = await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: '/opt/claude is not an executable file', stateSource: 'reported', turnCapture: false, bookmarks: false, inlineQuestions: false, commands: true, sandbox: false }
  });
  const agents = settingsPage.getByRole('group', { name: 'Agents' });
  await expect(agents).toBeVisible();
  const codex = agents.getByRole('group', { name: 'Codex' });
  await expect(codex).toContainText('Codex');
  await expect(codex).toContainText('/usr/local/bin/codex');
  await expect(codex).toContainText('Available');
  // an unlaunchable kind is dimmed and shows its reason
  const claude = agents.getByRole('group', { name: 'Claude' });
  await expect(claude).toHaveClass(/unavailable/);
  await expect(claude).toContainText('is not an executable file');
  // Codex accounts render because adapters.codex exists
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toBeVisible();
});

test('hides the AGENTS card and Codex accounts on an observe-only console', async ({ page }) => {
  const settingsPage = await openSettings(page, {});
  await expect(settingsPage.getByRole('group', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toHaveCount(0);
  // CLIENT and SERVER cards still render
  await expect(settingsPage.getByRole('group', { name: 'Client' })).toBeVisible();
  await expect(settingsPage.getByRole('group', { name: 'Server' })).toBeVisible();
});

test('opens settings as a full-screen page from a gear and returns focus to the console', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 812 });
  const settingsPage = await openSettings(page, {});
  const trigger = page.getByRole('button', { name: 'Global settings' });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(trigger.locator('svg')).toHaveCount(1);
  await expect(trigger).toHaveText('');
  await expect(page.getByRole('menu', { name: 'Global settings' })).toHaveCount(0);
  const bounds = await settingsPage.boundingBox();
  expect(bounds).not.toBeNull();
  // require measurable viewport coverage
  if (bounds === null) throw new Error('Settings page has no layout bounds');
  expect(Math.abs(bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.width - 428)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.height - 812)).toBeLessThanOrEqual(1);
  const back = settingsPage.getByRole('button', { name: 'Back to console' });
  await back.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(settingsPage.getByRole('button', { name: 'Larger terminal font' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settingsPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
