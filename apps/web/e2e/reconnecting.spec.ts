import { expect, test } from '@playwright/test';
import { dropPane, installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// retain cached output behind the blocking reconnect notice
test('blocks the console with a reconnecting overlay until the tunnel recovers', async ({ page }) => {
  test.setTimeout(60_000);
  await installPaneMock(page);
  let tunnelAvailable = true;
  await page.route('**/healthz', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/**', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  await expect(agentTab).toBeVisible();
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'CACHED-OUTPUT\r\n');
  const output = page.locator('.log-canvas .xterm-rows');
  await expect(output).toContainText('CACHED-OUTPUT');

  tunnelAvailable = false;
  await page.getByRole('button', { name: 'More options' }).click();

  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();
  // avoid duplicate notices when the pane disconnects during a console outage
  await dropPane(page, 'agent-1');
  const paneStatus = page.locator('.log-canvas .streamed-terminal-status');
  await expect(paneStatus).toHaveText('Reconnecting… (1006)');
  await expect(paneStatus).toBeHidden();
  const [bounds, viewport] = await Promise.all([overlay.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBe(0);
  expect(bounds!.y).toBe(0);
  expect(bounds!.width).toBe(viewport.width);
  expect(bounds!.height).toBe(viewport.height);
  await expect(agentTab).toHaveCount(1);
  await expect(output).toContainText('CACHED-OUTPUT');
  await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(overlay).toHaveCSS('background-image', 'none');
  // preserve sharp cached text beneath the original yellow border and hatching
  const cachedTreatment = overlay.locator('.log-cached-treatment');
  await expect(cachedTreatment).toHaveCSS('backdrop-filter', 'none');
  await expect(cachedTreatment).toHaveCSS('filter', 'none');
  await expect(cachedTreatment).toHaveCSS('border-top-width', '2px');
  await expect(cachedTreatment).toHaveCSS('border-top-style', 'solid');
  // tolerate color-mix rounding while checking the yellow palette and opacity
  await expect(cachedTreatment).toHaveCSS('border-top-color', /color\(srgb 0\.97647\d* 0\.88627\d* 0\.68627\d* \/ 0\.58\)/u);
  await expect(cachedTreatment).toHaveCSS('background-image', /repeating-linear-gradient\(135deg,/u);
  const message = overlay.locator('.reconnecting-message');
  await expect(message).toHaveText('Reconnecting…');
  await expect(message).toHaveCSS('color', 'rgb(249, 226, 175)');
  // keep the reconnect notice centered on desktop and phone
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const messageBounds = await message.boundingBox();
    expect(messageBounds).not.toBeNull();
    expect(messageBounds!.x + messageBounds!.width / 2).toBeCloseTo(size.width / 2, 0);
    expect(messageBounds!.y + messageBounds!.height / 2).toBeCloseTo(size.height / 2, 0);
  }

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(agentTab).toBeVisible();
  await expect(output).toContainText('CACHED-OUTPUT');
  await expect(paneStatus).toBeVisible();
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'FRESH-OUTPUT\r\n');
  await expect(output).toContainText('FRESH-OUTPUT');
  await expect(paneStatus).toBeHidden();
});

test('restores the session automatically when the tunnel is down during startup', async ({ page }) => {
  test.setTimeout(60_000);
  let tunnelAvailable = false;
  await page.route('**/healthz', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await page.route('**/api/**', async route => {
    if (!tunnelAvailable) return route.abort('failed');
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole('tab', { name: /^Ready/u })).toBeVisible();
  await expect(page.getByText('Unable to connect to the console')).toHaveCount(0);
});

test('keeps the console visible when a dashboard refresh times out', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  await page.route('**/healthz', route => route.fulfill({ status: 200, body: 'ok' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      if (dashboardRequests > 1) {
        await new Promise(resolve => setTimeout(resolve, 9_000));
        return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } }).catch(() => undefined);
      }
      return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(agentTab).toBeVisible();
  await expect.poll(() => dashboardRequests, { timeout: 8_000 }).toBeGreaterThan(1);
  await page.waitForTimeout(8_500);
  await expect(overlay).toHaveCount(0);
  await expect(agentTab).toBeVisible();
});
