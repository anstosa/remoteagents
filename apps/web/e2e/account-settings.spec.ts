import { expect, test, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture';

type Spend = { status: 'available'; todayUsd: number; weekUsd: number; asOf: number } | { status: 'unconfigured' | 'unavailable' };
type Account = {
  id: string;
  label: string;
  active: boolean;
  authMode?: 'apikey';
  spend?: Spend;
  email?: string;
  planType?: string;
  primary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
  secondary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
  resetCount?: number;
  error?: string;
};
type RenameFailure = 'http' | 'network';

// allow first-load compilation on shared CI hosts
test.describe.configure({ timeout: 180_000 });

// create one isolated settings backend
async function setupAccountSettings(page: Page, initialAccounts: Account[], renameFailures: RenameFailure[] = []) {
  const state = {
    accounts: structuredClone(initialAccounts),
    accountQueries: 0,
    patches: [] as Array<{ id: string; body: unknown; csrf: string }>,
    renameFailures: [...renameFailures],
  };
  // keep fixture sockets connected without a real backend
  await mockAccountSocket(page);
  // provide only synthetic local responses
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'account-settings-csrf', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // expose configured Codex without live agents
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // authorize the inert dashboard socket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // avoid unrelated update indicators
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // reload the server-owned labels whenever settings opens
    if (path === '/api/codex/accounts' && request.method() === 'GET') {
      state.accountQueries += 1;
      return route.fulfill({ json: { accounts: state.accounts } });
    }
    const renameMatch = path.match(/^\/api\/codex\/accounts\/([^/]+)$/u);
    // handle one account-label update
    if (renameMatch !== null && request.method() === 'PATCH') {
      const id = decodeURIComponent(renameMatch[1]);
      const body = request.postDataJSON() as { label?: unknown };
      state.patches.push({ id, body, csrf: request.headers()['x-csrf-token'] ?? '' });
      const failure = state.renameFailures.shift();
      // return one controlled HTTP failure
      if (failure === 'http') return route.fulfill({ status: 503, json: { error: 'Rename denied.' } });
      // simulate one lost transport
      if (failure === 'network') return route.abort('failed');
      const account = state.accounts.find(candidate => candidate.id === id);
      // reject fixture mistakes explicitly
      if (account === undefined || typeof body.label !== 'string') return route.fulfill({ status: 404, json: { error: 'Account unavailable.' } });
      account.label = body.label;
      // invert selection to prove the client merges only the returned label
      return route.fulfill({ json: { account: { id: account.id, label: account.label, active: !account.active, ...(account.authMode === undefined ? {} : { authMode: account.authMode }) } } });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}

// open the isolated global settings surface
async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

test('shows API-key spend and persists trimmed account and API-key names', async ({ page }) => {
  const pageErrors: string[] = [];
  // collect uncaught browser failures
  page.on('pageerror', error => pageErrors.push(error.message));
  const longKeyName = 'Production API key for the extraordinarily long west-coast autonomous research workspace';
  const resetAt = Math.floor(Date.now() / 1_000) + 86_400;
  const spendAsOf = Math.floor(Date.now() / 1_000);
  const state = await setupAccountSettings(page, [
    { id: 'chatgpt-account', label: 'Personal', email: 'personal@example.com', active: true, planType: 'pro', primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: resetAt }, secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: resetAt + 432_000 }, resetCount: 2 },
    { id: 'paid-key', label: 'Production API', active: false, authMode: 'apikey', spend: { status: 'available', todayUsd: 12.345, weekUsd: 80.1, asOf: spendAsOf } },
    { id: 'zero-key', label: 'Zero API', active: false, authMode: 'apikey', spend: { status: 'available', todayUsd: 0, weekUsd: 0, asOf: spendAsOf } },
    { id: 'missing-key', label: 'Unconfigured API', active: false, authMode: 'apikey', spend: { status: 'unconfigured' } },
    { id: 'unknown-key', label: 'Unknown billing API', active: false, authMode: 'apikey' },
    { id: 'failed-key', label: 'Unavailable API', active: false, authMode: 'apikey', spend: { status: 'unavailable' } },
  ]);
  let settings = await openSettings(page);
  const chatgpt = settings.getByRole('radio').filter({ hasText: 'personal@example.com' });
  const paid = settings.getByRole('radio').filter({ hasText: 'Production API' });
  const zero = settings.getByRole('radio').filter({ hasText: 'Zero API' });
  const unconfigured = settings.getByRole('radio').filter({ hasText: 'Unconfigured API' });
  const unknown = settings.getByRole('radio').filter({ hasText: 'Unknown billing API' });
  const unavailable = settings.getByRole('radio').filter({ hasText: 'Unavailable API' });

  await expect(settings.getByText('API-key spend is in USD, using UTC days and weeks starting Monday. OpenAI reporting may be delayed.')).toBeVisible();
  await expect(paid.getByText('Production API (API Key)', { exact: true })).toBeVisible();
  await expect(paid.getByText('Spent today', { exact: true })).toBeVisible();
  await expect(paid.getByText('Spent this week', { exact: true })).toBeVisible();
  await expect(paid.getByText('$12.35', { exact: true })).toBeVisible();
  await expect(paid.getByText('$80.10', { exact: true })).toBeVisible();
  await expect(paid).toContainText(/As of .+ UTC/u);
  await expect(zero.getByText('$0.00', { exact: true })).toHaveCount(2);
  await expect(unconfigured.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unconfigured).toContainText('OpenAI billing is not configured for this key.');
  await expect(unknown.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unknown).toContainText('Billing totals unavailable. Reopen settings to refresh.');
  await expect(unknown).not.toContainText('not configured');
  await expect(unavailable.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(unavailable).toContainText('Billing query failed. Reopen settings to retry.');
  await expect(unavailable).not.toContainText('$0.00');

  await settings.getByRole('button', { name: 'Rename Personal', exact: true }).click();
  let rename = page.getByRole('dialog', { name: 'Rename account', exact: true });
  const accountName = rename.getByLabel('account name', { exact: true });
  await expect(accountName).toHaveValue('Personal');
  await rename.getByRole('button', { name: 'Close rename account' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rename).toHaveCount(0);
  expect(state.patches).toEqual([]);

  await settings.getByRole('button', { name: 'Rename Personal', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename account', exact: true });
  await rename.getByLabel('account name', { exact: true }).fill('   ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await rename.getByLabel('account name', { exact: true }).fill('  Family Workspace  ');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(chatgpt).toContainText('Family Workspace (Pro)');
  await expect(chatgpt).toContainText('personal@example.com');
  await expect(chatgpt).toContainText('41% consumed');
  await expect(chatgpt).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('status')).toContainText('Renamed to Family Workspace.');

  await settings.getByRole('button', { name: 'Rename Production API', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  const keyName = rename.getByLabel('API key name', { exact: true });
  await expect(keyName).toHaveValue('Production API');
  await keyName.fill(`  ${longKeyName}  `);
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(paid).toContainText(`${longKeyName} (API Key)`);
  await expect(paid.getByText('$12.35', { exact: true })).toBeVisible();
  await expect(paid.getByText('$80.10', { exact: true })).toBeVisible();
  await expect(paid).toHaveAttribute('aria-checked', 'false');
  expect(state.patches).toEqual([
    { id: 'chatgpt-account', body: { label: 'Family Workspace' }, csrf: 'account-settings-csrf' },
    { id: 'paid-key', body: { label: longKeyName }, csrf: 'account-settings-csrf' },
  ]);
  await page.screenshot({ path: '/tmp/remoteagents-account-settings-desktop.png' });

  await settings.getByRole('button', { name: 'Back to console' }).click();
  await page.getByRole('button', { name: 'Global settings' }).click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('radio').filter({ hasText: 'Family Workspace' })).toContainText('personal@example.com');
  await expect(settings.getByRole('radio').filter({ hasText: `${longKeyName} (API Key)` })).toContainText('$80.10');
  expect(state.accountQueries).toBe(2);

  await page.setViewportSize({ width: 320, height: 640 });
  const mobileLongName = settings.getByText(`${longKeyName} (API Key)`, { exact: true });
  await mobileLongName.scrollIntoViewIfNeeded();
  await expect(mobileLongName).toBeInViewport();
  const horizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontalMetrics.document).toBeLessThanOrEqual(horizontalMetrics.viewport);
  expect(horizontalMetrics.body).toBeLessThanOrEqual(horizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-account-settings-mobile.png' });
  expect(pageErrors).toEqual([]);
});

test('keeps rename drafts through cancel, HTTP failure, network failure, and retry', async ({ page }) => {
  const pageErrors: string[] = [];
  // collect uncaught browser failures
  page.on('pageerror', error => pageErrors.push(error.message));
  const state = await setupAccountSettings(page, [
    { id: 'retry-key', label: 'Retry API', active: true, authMode: 'apikey', spend: { status: 'available', todayUsd: 1.25, weekUsd: 4.5, asOf: Math.floor(Date.now() / 1_000) }, error: 'Retained provider warning' },
  ], ['http', 'network']);
  const settings = await openSettings(page);

  await settings.getByRole('button', { name: 'Rename Retry API', exact: true }).click();
  let rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  await rename.getByLabel('API key name', { exact: true }).fill('Cancelled name');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(settings.getByRole('radio').filter({ hasText: 'Retry API' })).toBeVisible();
  expect(state.patches).toEqual([]);

  await settings.getByRole('button', { name: 'Rename Retry API', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  const input = rename.getByLabel('API key name', { exact: true });
  await input.fill('  Durable retry name  ');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename.getByRole('alert')).toHaveText('Rename denied.');
  await expect(input).toHaveValue('  Durable retry name  ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename.getByRole('alert')).toHaveText('Console unavailable');
  await expect(input).toHaveValue('  Durable retry name  ');
  await expect(rename.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toHaveCount(0);
  const renamed = settings.getByRole('radio').filter({ hasText: 'Durable retry name' });
  await expect(renamed).toHaveAttribute('aria-checked', 'true');
  await expect(renamed).toContainText('$1.25');
  await expect(renamed).toContainText('$4.50');
  await expect(renamed).toContainText('Retained provider warning');
  await expect(settings.getByRole('status')).toContainText('Renamed to Durable retry name.');
  expect(state.patches).toEqual([
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
    { id: 'retry-key', body: { label: 'Durable retry name' }, csrf: 'account-settings-csrf' },
  ]);
  expect(pageErrors).toEqual([]);
});

test('rejects a malformed API-key spend contract instead of showing zero dollars', async ({ page }) => {
  const malformed = { id: 'malformed-key', label: 'Malformed API', active: true, authMode: 'apikey' as const, spend: { status: 'available', todayUsd: 0, asOf: 1_800_000_000 } };
  await setupAccountSettings(page, [malformed as unknown as Account]);
  const settings = await openSettings(page);
  await expect(settings.getByRole('status')).toHaveText('Unable to load ChatGPT accounts.');
  await expect(settings.getByRole('radiogroup', { name: 'ChatGPT accounts' }).getByRole('radio')).toHaveCount(0);
  await expect(settings).not.toContainText('$0.00');
});

test('stops labeling yesterday totals as today and requeries after UTC rollover', async ({ page }) => {
  const startingTime = new Date('2026-09-11T23:50:00.000Z');
  const rolloverTime = new Date('2026-09-11T23:59:59.500Z');
  const spendAsOf = Math.floor(rolloverTime.valueOf() / 1_000);
  await page.clock.install({ time: startingTime });
  const state = await setupAccountSettings(page, [
    { id: 'rollover-key', label: 'Rollover API', active: true, authMode: 'apikey', spend: { status: 'available', todayUsd: 7, weekUsd: 21, asOf: spendAsOf } },
  ]);
  const settings = await openSettings(page);
  const row = settings.getByRole('radio').filter({ hasText: 'Rollover API' });
  await expect(row.getByText('$7.00', { exact: true })).toBeVisible();
  expect(state.accountQueries).toBe(1);

  await page.clock.pauseAt(rolloverTime);
  await page.clock.runFor(1_000);
  await expect.poll(() => state.accountQueries).toBeGreaterThanOrEqual(2);
  await expect(row.getByText('Unavailable', { exact: true })).toHaveCount(2);
  await expect(row).toContainText('Previous-day totals hidden. Reopen settings to refresh.');
  await expect(row).not.toContainText('$7.00');
});

test('keeps all ChatGPT account actions on one row at desktop and mobile widths', async ({ page }) => {
  await setupAccountSettings(page, [
    { id: 'action-account', label: 'Action account', email: 'actions@example.com', active: true, planType: 'pro', primary: { usedPercent: 100 }, resetCount: 1, error: 'Account query failed' },
  ]);
  const settings = await openSettings(page);
  const actions = settings.getByRole('group', { name: 'Actions for Action account', exact: true });
  const rename = actions.getByRole('button', { name: 'Rename Action account', exact: true });
  const reset = actions.getByRole('button', { name: 'Use reset for Action account', exact: true });
  const relogin = actions.getByRole('button', { name: 'Re-login to Action account', exact: true });
  await expect(actions.getByRole('button')).toHaveCount(3);
  await expect(actions.getByRole('button')).toHaveText(['Rename', 'Use reset', 'Re-login']);
  await actions.scrollIntoViewIfNeeded();
  await expect(actions).toBeInViewport();

  const desktopRename = await rename.boundingBox();
  const desktopReset = await reset.boundingBox();
  const desktopRelogin = await relogin.boundingBox();
  expect(desktopRename).not.toBeNull();
  expect(desktopReset).not.toBeNull();
  expect(desktopRelogin).not.toBeNull();
  expect(Math.abs(desktopRename!.y - desktopReset!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopReset!.y - desktopRelogin!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopRename!.height - desktopReset!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopReset!.height - desktopRelogin!.height)).toBeLessThanOrEqual(1);
  expect(desktopRename!.x + desktopRename!.width).toBeLessThan(desktopReset!.x);
  expect(desktopReset!.x + desktopReset!.width).toBeLessThan(desktopRelogin!.x);
  await page.screenshot({ path: '/tmp/remoteagents-account-actions-desktop.png' });

  await page.setViewportSize({ width: 320, height: 640 });
  await actions.scrollIntoViewIfNeeded();
  await expect(actions).toBeInViewport();
  const mobileRename = await rename.boundingBox();
  const mobileReset = await reset.boundingBox();
  const mobileRelogin = await relogin.boundingBox();
  expect(mobileRename).not.toBeNull();
  expect(mobileReset).not.toBeNull();
  expect(mobileRelogin).not.toBeNull();
  expect(Math.abs(mobileRename!.y - mobileReset!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileReset!.y - mobileRelogin!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileRename!.height - mobileReset!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileReset!.height - mobileRelogin!.height)).toBeLessThanOrEqual(1);
  expect(mobileRename!.x + mobileRename!.width).toBeLessThan(mobileReset!.x);
  expect(mobileReset!.x + mobileReset!.width).toBeLessThan(mobileRelogin!.x);
  const horizontalMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontalMetrics.document).toBeLessThanOrEqual(horizontalMetrics.viewport);
  expect(horizontalMetrics.body).toBeLessThanOrEqual(horizontalMetrics.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-account-actions-mobile.png' });
});
