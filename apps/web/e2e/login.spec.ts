import { expect, test } from '@playwright/test';
test('renders the protected console login screen', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle('Remote Agent Console'); await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible(); await expect(page.getByLabel('Password')).toBeVisible(); });

test('shows the controlling device and prompts an unnamed device before takeover', async ({ page }) => {
  let takeover: unknown;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: false, controllingDeviceName: 'Studio Mac' } });
    if (url.pathname === '/api/auth/take-control') {
      takeover = route.request().postDataJSON();
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' } });
    }
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const controller = page.getByText('Studio Mac is active', { exact: true });
  await expect(controller).toBeVisible();
  await expect(controller).toHaveCSS('text-align', 'center');
  const name = page.getByLabel('Device name');
  await expect(name).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeDisabled();
  await name.fill('Kitchen iPad');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => takeover).toEqual({ deviceName: 'Kitchen iPad' });
});

test('lets a named device take control without asking for its name again', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: false, deviceName: 'Kitchen iPad', controllingDeviceName: 'Studio Mac' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Studio Mac is active', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Device name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
});

test('prompts the first active device for a name before opening the console', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Name this device.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Device name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save device name', exact: true })).toBeDisabled();
});
