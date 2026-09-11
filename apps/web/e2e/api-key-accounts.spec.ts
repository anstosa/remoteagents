import { expect, test, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture';

// provide isolated accounts without touching real credentials
async function setupAccounts(page: Page) {
  const state = { saved: [] as unknown[], cancelled: [] as string[], csrf: '', starts: 0 };
  const accounts = [{ id: 'account-1', label: 'Personal', email: 'personal@example.com', active: true }];
  // keep fixture sockets connected without a backend
  await mockAccountSocket(page);
  // serve only synthetic account data
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one controlling browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'account-csrf', active: true, deviceName: 'Test device', server: { name: 'Test server', url: 'https://agents.example.com', remotes: [] } } });
    // expose configured Codex without live agents
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // authorize the inert dashboard socket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // avoid unrelated update indicators
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // expose saved accounts on settings open
    if (path === '/api/codex/accounts') return route.fulfill({ json: { accounts } });
    // save one key without selecting it
    if (path === '/api/codex/accounts/api-key') {
      state.saved.push(request.postDataJSON());
      state.csrf = request.headers()['x-csrf-token'] ?? '';
      const account = { id: 'account-2', label: 'API key (account-2)', authMode: 'apikey', active: false };
      return route.fulfill({ status: 201, json: { account } });
    }
    // create a pending device session for each popup
    if (path === '/api/codex/accounts/login') {
      state.starts += 1;
      return route.fulfill({ status: 201, json: { login: { loginId: `device-${state.starts}`, verificationUrl: 'https://auth.openai.com/device', userCode: 'TEST-CODE' } } });
    }
    // record device-session cleanup
    if (path.startsWith('/api/codex/accounts/login/') && request.method() === 'DELETE') {
      state.cancelled.push(path.split('/').at(-1)!);
      return route.fulfill({ status: 204 });
    }
    // leave device authorization pending
    if (path.startsWith('/api/codex/accounts/login/')) return route.fulfill({ json: { status: 'pending' } });
    return route.fulfill({ json: {} });
  });
  return state;
}

// open the add popup through global settings
async function openAccountDialog(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: '+ Add account' }).click();
  return page.getByRole('dialog', { name: 'Add ChatGPT account', exact: true });
}

// cover the successful credential alternative and secret lifetime
test('adds a masked API key without changing the selected account', async ({ page }) => {
  const errors: string[] = [];
  // collect uncaught browser failures
  page.on('pageerror', error => errors.push(error.message));
  const state = await setupAccounts(page);
  const dialog = await openAccountDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Or use an API key' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'TEST-CODE' })).toBeVisible();
  const input = dialog.getByLabel('API key', { exact: true });
  const submit = dialog.getByRole('button', { name: 'Add API key', exact: true });
  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toHaveAttribute('autocomplete', 'off');
  // keep keyboard focus inside the popup in both directions
  await dialog.getByRole('button', { name: 'Close account login' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close account login' })).toBeFocused();
  await page.screenshot({ path: '/tmp/remoteagents-api-key-desktop.png' });
  // keep the full device and key flow usable on short mobile screens
  await page.setViewportSize({ width: 360, height: 480 });
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await page.screenshot({ path: '/tmp/remoteagents-api-key-mobile-ready.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(submit).toBeDisabled();
  await input.fill('   ');
  await expect(submit).toBeDisabled();
  await input.fill('  sk-synthetic-test-only  ');
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(state.saved).toEqual([{ apiKey: 'sk-synthetic-test-only' }]);
  expect(state.csrf).toBe('account-csrf');
  expect(state.cancelled).toEqual(['device-1']);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('radio', { name: 'personal@example.com' })).toHaveAttribute('aria-checked', 'true');
  const savedKey = settings.getByRole('radio', { name: /API key \(API Key\)/u });
  await expect(savedKey).toHaveAttribute('aria-checked', 'false');
  await expect(savedKey.getByText('API key (API Key)', { exact: true })).toBeVisible();
  await expect(settings.getByRole('status')).toContainText('API key added. Select it to use it.');
  await expect(settings).not.toContainText('account-2');
  await settings.getByRole('button', { name: 'Rename API key', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename API key', exact: true });
  await expect(rename.getByLabel('API key name', { exact: true })).toHaveValue('API key');
  await expect(rename).not.toContainText('account-2');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  // verify no browser storage retains the pasted key
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('sk-synthetic-test-only');
  await settings.getByRole('button', { name: '+ Add account' }).click();
  await expect(input).toHaveValue('');
  await input.fill('sk-cancelled-test-only');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings.getByRole('button', { name: '+ Add account' }).click();
  await expect(input).toHaveValue('');
  expect(errors).toEqual([]);
});

// preserve selection and billing metadata when the same key is saved again
test('reuses an already selected API-key account', async ({ page }) => {
  await setupAccounts(page);
  // provide a billed key before another saved account
  await page.route('**/api/codex/accounts', route => route.fulfill({ json: { accounts: [
    { id: 'account-1', label: 'Production', authMode: 'apikey', active: true, spend: { status: 'available', todayUsd: 1.25, weekUsd: 8.50, asOf: Math.floor(Date.now() / 1_000) } },
    { id: 'account-2', label: 'Personal', email: 'personal@example.com', active: false }
  ] } }));
  // return the same selected slot rather than a new account
  await page.route('**/api/codex/accounts/api-key', route => route.fulfill({ status: 201, json: { account: { id: 'account-1', label: 'Production', authMode: 'apikey', active: true } } }));
  const dialog = await openAccountDialog(page);
  await dialog.getByLabel('API key', { exact: true }).fill('sk-synthetic-test-only');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const rows = settings.getByRole('radiogroup', { name: 'ChatGPT accounts' }).getByRole('radio');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAccessibleName(/Production \(API Key\)/u);
  await expect(rows.first()).toHaveAttribute('aria-checked', 'true');
  await expect(rows.first().getByText('$1.25', { exact: true })).toBeVisible();
  await expect(rows.first().getByText('$8.50', { exact: true })).toBeVisible();
  await expect(rows.first()).not.toContainText('Unavailable');
  await expect(settings.getByRole('status')).toContainText('Production saved. This account is already selected.');
});

// prevent device authentication from overwriting a failed API-key account
test('does not offer ChatGPT repair or reset actions for an API-key account', async ({ page }) => {
  await setupAccounts(page);
  // expose a failed API-key account with stale usage metadata
  await page.route('**/api/codex/accounts', route => route.fulfill({ json: { accounts: [{ id: 'account-1', label: 'API key (account-1)', authMode: 'apikey', active: true, error: 'Account query failed', primary: { usedPercent: 100 }, resetCount: 1 }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const savedKey = settings.getByRole('radio', { name: /API key \(API Key\)/u });
  await expect(savedKey).toContainText('Account query failed');
  await expect(savedKey).not.toContainText('account-1');
  await expect(settings.getByRole('button', { name: /Re-login/u })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /Use reset/u })).toHaveCount(0);
  await settings.getByRole('button', { name: '+ Add account' }).click();
  await expect(page.getByRole('dialog', { name: 'Add ChatGPT account', exact: true }).getByLabel('API key', { exact: true })).toBeVisible();
});

// keep failed keys editable and prevent duplicate pending saves
test('handles malformed input and save failures without exposing provider errors', async ({ page }) => {
  const state = await setupAccounts(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { /* release the first save explicitly */ release = resolve; });
  let attempts = 0;
  // delay and fail the first save before allowing a retry
  await page.route('**/api/codex/accounts/api-key', async route => {
    attempts += 1;
    // use the ordinary success fixture after the failure
    if (attempts > 1) return route.fallback();
    await held;
    return route.fulfill({ status: 503, json: { error: 'provider echoed sk-synthetic-test-only' } });
  });
  const dialog = await openAccountDialog(page);
  const input = dialog.getByLabel('API key', { exact: true });
  await input.fill('sk invalid');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('without spaces');
  expect(attempts).toBe(0);
  await input.fill('sk-synthetic-test-only');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect.poll(() => attempts).toBe(1);
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close account login' })).toBeDisabled();
  release();
  await expect(dialog.getByRole('alert')).toHaveText('Unable to save API key. Check the key and try again.');
  await expect(dialog).not.toContainText('sk-synthetic-test-only');
  await expect(input).toHaveValue('sk-synthetic-test-only');
  await expect(dialog.getByRole('button', { name: 'Use device authentication' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(state.saved).toHaveLength(1);
});

// avoid depending on a successful device-code startup
test('accepts a key while device startup is pending and cancels the late session', async ({ page }) => {
  const state = await setupAccounts(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { /* hold device startup */ release = resolve; });
  // return the device session only after the API key succeeds
  await page.route('**/api/codex/accounts/login', async route => {
    await held;
    return route.fulfill({ status: 201, json: { login: { loginId: 'late-device', verificationUrl: 'https://auth.openai.com/device', userCode: 'LATE-CODE' } } });
  });
  const dialog = await openAccountDialog(page);
  await expect(dialog).toContainText('Starting secure ChatGPT login…');
  await dialog.getByLabel('API key', { exact: true }).fill('sk-synthetic-test-only');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  release();
  await expect.poll(() => state.cancelled).toEqual(['late-device']);
  expect(state.saved).toHaveLength(1);
});

// ignore device completions superseded by an API-key submission
test('ignores a stale device completion while saving an API key', async ({ page }) => {
  await setupAccounts(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { /* control the device completion race */ release = resolve; });
  let polling = false;
  // delay one status response across the API-key submission
  await page.route('**/api/codex/accounts/login/device-1', async route => {
    // allow cancellation to proceed independently
    if (route.request().method() === 'DELETE') return route.fallback();
    polling = true;
    await held;
    return route.fulfill({ json: { status: 'succeeded', account: { id: 'stale-device', label: 'stale@example.com', active: false } } });
  });
  // release the obsolete poll before the key response
  await page.route('**/api/codex/accounts/api-key', async route => {
    release();
    return route.fallback();
  });
  const dialog = await openAccountDialog(page);
  await expect.poll(() => polling).toBe(true);
  await dialog.getByLabel('API key', { exact: true }).fill('sk-synthetic-test-only');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('radio', { name: /API key \(API Key\)/u })).toBeVisible();
  await expect(settings.getByRole('radio', { name: 'stale@example.com' })).toHaveCount(0);
  await expect(settings.getByRole('status')).toContainText('API key added.');
  await expect(settings).not.toContainText('account-2');
});

// let an already-finalizing device login finish without adding a second account
test('waits when device completion wins the cancellation race', async ({ page }) => {
  const state = await setupAccounts(page);
  let completed = false;
  const account = { id: 'device-account', label: 'device@example.com', active: false };
  // report completion as in progress until the test releases it
  await page.route('**/api/codex/accounts/login/device-1', route => {
    // reject cancellation after the server claims finalization
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 404, json: { error: 'ChatGPT login unavailable.' } });
    return route.fulfill({ json: completed ? { status: 'succeeded', account } : { status: 'pending' } });
  });
  // include the completed device identity in the refreshed list
  await page.route('**/api/codex/accounts', route => route.fulfill({ json: { accounts: completed ? [account] : [] } }));
  const dialog = await openAccountDialog(page);
  await expect(dialog.getByRole('button', { name: 'TEST-CODE' })).toBeVisible();
  const input = dialog.getByLabel('API key', { exact: true });
  await input.fill('sk-synthetic-test-only');
  await dialog.getByRole('button', { name: 'Add API key', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Device sign-in could not be cancelled.');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('sk-synthetic-test-only');
  expect(state.saved).toEqual([]);
  completed = true;
  await expect(dialog).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('radio', { name: 'device@example.com' })).toBeVisible();
  await expect(settings.getByRole('status')).toContainText('device@example.com added.');
  expect(state.saved).toEqual([]);
});

// exercise the complete alternative on a narrow rendered viewport
test('keeps the API-key section reachable on mobile after device login fails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await setupAccounts(page);
  // fail device startup without affecting API-key storage
  await page.route('**/api/codex/accounts/login', route => route.fulfill({ status: 503, json: { error: 'Device login unavailable.' } }));
  const dialog = await openAccountDialog(page);
  await expect(dialog).toContainText('Device login unavailable.');
  const input = dialog.getByLabel('API key', { exact: true });
  await input.fill('sk-synthetic-test-only');
  const submit = dialog.getByRole('button', { name: 'Add API key', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  // verify the popup fits horizontally without leaking the secret into text
  const dimensions = await dialog.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  await expect(dialog).not.toContainText('sk-synthetic-test-only');
  await page.screenshot({ path: '/tmp/remoteagents-api-key-mobile.png' });
  await submit.click();
  await expect(dialog).toHaveCount(0);
});
