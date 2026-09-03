import { expect, test } from '@playwright/test';

// stub a controlled console whose dashboard carries the given adapter capabilities
async function openSettings(page: import('@playwright/test').Page, adapters: unknown, options: { defaultAgent?: string; davo?: { enabled: boolean; available: boolean; name: string; context: string }; onDefaultAgent?: (kind: string) => void; onDavo?: (settings: { enabled: boolean; name: string; context: string }) => void } = {}) {
  const davo = options.davo ?? { enabled: false, available: true, name: 'Davo', context: 'Existing Davo persona.' };
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
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'adapter-csrf', active: true, deviceName: 'Test device', ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }), davo, server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // persist one selected default agent
    if (url.pathname === '/api/server/default-agent' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { kind: string };
      options.onDefaultAgent?.(payload.kind);
      return route.fulfill({ json: { defaultAgent: payload.kind } });
    }
    // persist one voice settings update
    if (url.pathname === '/api/server/davo' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { enabled: boolean; name: string; context: string };
      options.onDavo?.(payload);
      return route.fulfill({ json: { davo: { ...payload, available: davo.available } } });
    }
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
  }, { defaultAgent: 'codex' });
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
  const defaultAgent = settingsPage.getByRole('combobox', { name: 'Default agent' });
  await expect(defaultAgent).toHaveValue('codex');
  await expect(defaultAgent.locator('option[value="claude"]')).toBeDisabled();
  // Codex accounts render because adapters.codex exists
  const accountsTitle = settingsPage.getByRole('heading', { name: 'Accounts' });
  const addAccount = settingsPage.getByRole('button', { name: '+ Add account' });
  await expect(addAccount).toBeVisible();
  const [titleBounds, addBounds] = await Promise.all([accountsTitle.boundingBox(), addAccount.boundingBox()]);
  expect(addBounds?.x).toBeGreaterThan((titleBounds?.x ?? 0) + (titleBounds?.width ?? 0));
  expect(addBounds?.height).toBeLessThanOrEqual(32);
  await expect(settingsPage.getByText('Identify this browser and server')).toHaveCount(0);
  await expect(settingsPage.getByText('Choose the account Codex uses')).toHaveCount(0);
});

test('changes the server default agent without closing settings', async ({ page }) => {
  let selected: string | undefined;
  const settingsPage = await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, bookmarks: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex', onDefaultAgent: kind => { selected = kind; } });

  const picker = settingsPage.getByRole('combobox', { name: 'Default agent' });
  await picker.selectOption('claude');

  await expect.poll(() => selected).toBe('claude');
  await expect(picker).toHaveValue('claude');
  await expect(settingsPage).toBeVisible();
});

test('enables Davo and saves a configurable name and context', async ({ page }) => {
  const updates: Array<{ enabled: boolean; name: string; context: string }> = [];
  const settingsPage = await openSettings(page, {}, { onDavo: settings => { updates.push(settings); } });
  const enabled = settingsPage.getByRole('checkbox', { name: 'Enable Davo' });

  await expect(enabled).not.toBeChecked();
  await expect(settingsPage.getByLabel('Davo name')).toHaveCount(0);
  await enabled.check();
  await expect(settingsPage.getByLabel('Davo name')).toHaveValue('Davo');
  await expect(settingsPage.getByLabel('Davo context')).toHaveValue('Existing Davo persona.');
  await settingsPage.getByLabel('Davo name').fill('Riley');
  await settingsPage.getByLabel('Davo context').fill('Speak plainly and keep the tone dry.');
  await settingsPage.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => updates).toEqual([
    { enabled: true, name: 'Davo', context: 'Existing Davo persona.' },
    { enabled: true, name: 'Riley', context: 'Speak plainly and keep the tone dry.' }
  ]);
  await expect(settingsPage.getByText('Saved.')).toBeVisible();
  await expect(settingsPage).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Back to console' }).click();
  await expect(page.getByRole('button', { name: 'Call Riley' }).first()).toBeVisible();
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
  await expect(settingsPage.getByRole('checkbox', { name: 'Enable Davo' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settingsPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
