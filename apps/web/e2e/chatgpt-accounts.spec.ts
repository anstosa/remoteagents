import { expect, test } from '@playwright/test';

test('queries, repairs, switches, and adds ChatGPT accounts from global settings', async ({ page }) => {
  let activeAccount = 'account-1';
  let accountQueries = 0;
  let addLoginPolls = 0;
  let repairLoginPolls = 0;
  let repairComplete = false;
  const loginBodies: unknown[] = [];
  let switchBody: unknown;
  let switchCsrf = '';
  let resetCsrf = '';
  let personalUsed = 100;
  let personalResets = 2;
  const resetAt = Math.floor(Date.now() / 1_000) + 90_065;
  // provide connected dashboard sockets
  await page.addInitScript(() => {
    // provide a successful clipboard write
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open each fixture socket asynchronously
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close each fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  // build the current safe account list
  const accounts = () => [
    { id: 'account-1', label: 'Personal', email: 'personal@example.com', active: activeAccount === 'account-1', planType: 'pro', primary: { usedPercent: personalUsed, windowDurationMins: 300, resetsAt: resetAt }, secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: resetAt + 432_000 }, resetCount: personalResets },
    { id: 'account-2', label: 'Work', email: 'work@example.com', active: activeAccount === 'account-2', planType: 'business', primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: resetAt }, resetCount: 0, ...(repairComplete ? {} : { error: 'Account query failed' }) },
    ...(addLoginPolls > 1 ? [{ id: 'account-3', label: 'new@example.com', email: 'new@example.com', active: false, planType: 'plus' }] : [])
  ];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlled console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'account-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // return one idle worktree agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // query every account on menu open
    if (url.pathname === '/api/codex/accounts' && request.method() === 'GET') {
      accountQueries += 1;
      return route.fulfill({ json: { accounts: accounts() } });
    }
    // switch the selected global account
    if (url.pathname === '/api/codex/accounts/switch') {
      switchBody = request.postDataJSON();
      switchCsrf = request.headers()['x-csrf-token'] ?? '';
      activeAccount = 'account-2';
      return route.fulfill({ json: { account: accounts()[1], restarts: [{ worktreeId: 'cora', status: 'restarted' }] } });
    }
    // redeem one account reset credit
    if (url.pathname === '/api/codex/accounts/account-1/reset' && request.method() === 'POST') {
      resetCsrf = request.headers()['x-csrf-token'] ?? '';
      personalUsed = 0;
      personalResets = 1;
      return route.fulfill({ json: { outcome: 'reset', account: accounts()[0] } });
    }
    // start an add or repair device-code login
    if (url.pathname === '/api/codex/accounts/login' && request.method() === 'POST') {
      const posted = request.postData();
      const payload = posted === null ? undefined : JSON.parse(posted) as unknown;
      loginBodies.push(payload);
      const repairing = payload !== null && typeof payload === 'object' && (payload as { repairAccountId?: unknown }).repairAccountId === 'account-2';
      return route.fulfill({ status: 201, json: { login: { loginId: repairing ? 'login-repair' : 'login-add', verificationUrl: 'https://auth.openai.com/device', userCode: repairing ? 'FIX-WORK' : 'ABCD-EFGH' } } });
    }
    // complete one repair after a pending poll
    if (url.pathname === '/api/codex/accounts/login/login-repair') {
      repairLoginPolls += 1;
      // publish repaired credentials only after authentication
      if (repairLoginPolls > 1) repairComplete = true;
      return route.fulfill({ json: repairComplete ? { status: 'succeeded', account: accounts()[1] } : { status: 'pending' } });
    }
    // complete one added account after a pending poll
    if (url.pathname === '/api/codex/accounts/login/login-add') {
      addLoginPolls += 1;
      return route.fulfill({ json: addLoginPolls > 1 ? { status: 'succeeded', account: { id: 'account-3', label: 'new@example.com', email: 'new@example.com', active: false, planType: 'plus' } } : { status: 'pending' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const settings = page.getByRole('button', { name: 'Global settings' });
  await settings.click();
  const menu = page.getByRole('menu', { name: 'Global settings' });
  const personal = menu.getByRole('menuitemradio', { name: /personal@example\.com/u });
  const work = menu.getByRole('menuitemradio', { name: /work@example\.com/u });
  await expect(personal).toHaveAttribute('aria-checked', 'true');
  await expect(personal).toContainText('personal@example.com (Pro)');
  await expect(personal).not.toContainText('Personal');
  await expect(work).not.toContainText('Work');
  await expect(personal).toContainText('100% consumed');
  await expect(personal).toContainText('7d limit');
  await expect(personal.getByRole('progressbar', { name: '5h ChatGPT limit consumed' })).toHaveAttribute('value', '100');
  await expect(personal.getByRole('progressbar', { name: '7d ChatGPT limit consumed' })).toHaveAttribute('value', '62');
  await expect(personal).toContainText('2 resets available');
  await expect(work).not.toContainText('resets available');
  const countdown = personal.locator('.chatgpt-limit-reset').first();
  await expect(countdown).toContainText(/Resets in 1d 01h 01m \d{2}s/u);
  const initialCountdown = await countdown.textContent();
  await expect.poll(async () => await countdown.textContent(), { timeout: 2_500 }).not.toBe(initialCountdown);
  expect(accountQueries).toBe(1);

  const useReset = menu.getByRole('menuitem', { name: 'Use reset for personal@example.com' });
  await useReset.click();
  await expect(personal.getByRole('progressbar', { name: '5h ChatGPT limit consumed' })).toHaveAttribute('value', '0');
  await expect(personal).toContainText('1 reset available');
  await expect(useReset).toHaveCount(0);
  await expect(menu.getByRole('status')).toContainText('Used one reset for personal@example.com.');
  expect(resetCsrf).toBe('account-csrf');

  const relogin = menu.getByRole('menuitem', { name: 'Re-login to work@example.com' });
  await relogin.click();
  const repairDialog = page.getByRole('dialog', { name: 'Re-login to ChatGPT' });
  await expect(repairDialog.getByRole('link', { name: /Open activation page/u })).toHaveAttribute('href', 'https://auth.openai.com/device');
  await expect(repairDialog.getByText('DEVICE CODE')).toBeVisible();
  const repairCode = repairDialog.getByRole('button', { name: 'FIX-WORK' });
  await expect(repairCode).toBeVisible();
  await repairCode.click();
  await expect(repairDialog.getByText('Copied!')).toBeVisible();
  await expect(repairDialog).toContainText('Waiting for authorization…');
  await expect(repairDialog).toHaveCount(0, { timeout: 5_000 });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('status')).toContainText('Re-login complete for work@example.com.');
  await expect(personal).toHaveAttribute('aria-checked', 'true');
  await expect(work).toHaveAttribute('aria-checked', 'false');
  expect(loginBodies[0]).toEqual({ repairAccountId: 'account-2' });

  await work.click();
  await expect(work).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('status')).toContainText('Restarted 1 idle worktree.');
  expect(switchBody).toEqual({ id: 'account-2' });
  expect(switchCsrf).toBe('account-csrf');

  await menu.getByRole('menuitem', { name: '+ Add account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add ChatGPT account' });
  await expect(dialog.getByRole('link', { name: /Open activation page/u })).toHaveAttribute('href', 'https://auth.openai.com/device');
  await expect(dialog.getByRole('button', { name: 'ABCD-EFGH' })).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('status')).toContainText('new@example.com added.');
  const added = menu.getByRole('menuitemradio', { name: /new@example.com/u });
  await expect(added).toBeVisible();
  await expect(added).toHaveAttribute('aria-checked', 'false');
  await expect(work).toHaveAttribute('aria-checked', 'true');
  expect(loginBodies[1]).toBeUndefined();
  expect(accountQueries).toBeGreaterThanOrEqual(3);
});

test('cancels a device login that starts after its dialog closes', async ({ page }) => {
  let finishLogin!: () => void;
  const loginReady = new Promise<void>(resolve => { finishLogin = resolve; });
  let cancelledLoginId = '';
  // provide inert fixture sockets
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
      // open each fixture socket asynchronously
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close each fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlled console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'account-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // return one idle worktree agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // authorize the dashboard socket
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // authorize the log socket
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return no saved prompts
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // return no queued prompts
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // return no prompt history
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // return no skills
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    // return no worktree notes
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // return no push key
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // return no configured accounts
    if (url.pathname === '/api/codex/accounts' && request.method() === 'GET') return route.fulfill({ json: { accounts: [] } });
    // hold login startup until after the dialog closes
    if (url.pathname === '/api/codex/accounts/login' && request.method() === 'POST') {
      await loginReady;
      return route.fulfill({ status: 201, json: { login: { loginId: 'late-login', verificationUrl: 'https://auth.openai.com/device', userCode: 'LATE-CODE' } } });
    }
    // record late-session cancellation
    if (url.pathname === '/api/codex/accounts/login/late-login' && request.method() === 'DELETE') {
      cancelledLoginId = 'late-login';
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).click();
  await page.getByRole('menuitem', { name: '+ Add account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add ChatGPT account' });
  await expect(dialog).toContainText('Starting secure ChatGPT login…');
  await dialog.getByRole('button', { name: 'Close account login' }).click();
  finishLogin();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => cancelledLoginId).toBe('late-login');
});
