import { expect, test } from '@playwright/test';

test('places the update chip in the tab bar beside notification controls', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs" role="tablist" style="width: 800px">
      <button role="tab">Agent</button>
      <button class="notification-control" type="button">Enable alerts</button>
      <button class="update-ready" type="button">Update available <span>Restart</span></button>
      <span class="launcher"><button class="new-agent-tab" type="button">+</button></span>
    </nav>
    <section class="panel" style="width: 800px; height: 500px"></section>
  `);

  const tabs = page.getByRole('tablist');
  const notification = page.getByRole('button', { name: 'Enable alerts' });
  const banner = page.getByRole('button', { name: 'Update available Restart' });
  await expect(tabs.locator(':scope > .update-ready')).toHaveCount(1);
  await expect(page.locator('.panel .update-ready')).toHaveCount(0);
  const [notificationBounds, bannerBounds] = await Promise.all([notification.boundingBox(), banner.boundingBox()]);
  expect(notificationBounds).not.toBeNull();
  expect(bannerBounds).not.toBeNull();
  expect(Math.abs(notificationBounds!.y + notificationBounds!.height / 2 - (bannerBounds!.y + bannerBounds!.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(notificationBounds!.height - bannerBounds!.height)).toBeLessThanOrEqual(1);
});

// verify failed updates remain beside output status
test('shows a failed update beside the output status without overlap', async ({ page }) => {
  let updateStarts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render one stable agent tab
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // start one host update
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // finish one failed host update
    if (url.pathname === '/api/server/update/server_update_operation_1234') return route.fulfill({ json: { id: 'server_update_operation_1234', kind: 'update', state: 'failed' } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent output
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt stores
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const banner = page.getByRole('button', { name: 'Update available Restart' });
  await expect(banner).toBeVisible();
  await banner.click();

  await expect.poll(() => updateStarts).toBe(1);
  const alert = page.getByRole('alert').filter({ hasText: 'Restart failed. Check the server logs.' });
  await expect(alert).toBeVisible();
  const status = page.locator('.log-status');
  const [alertBounds, statusBounds] = await Promise.all([alert.boundingBox(), status.boundingBox()]);
  expect(alertBounds).not.toBeNull();
  expect(statusBounds).not.toBeNull();
  expect(Math.abs(alertBounds!.y - statusBounds!.y)).toBeLessThanOrEqual(1);
  expect(alertBounds!.x).toBeGreaterThanOrEqual(statusBounds!.x + statusBounds!.width + 4);
});
