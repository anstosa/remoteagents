import { expect, test } from '@playwright/test';

test('blocks the console with a reconnecting overlay until the tunnel recovers', async ({ page }) => {
  test.setTimeout(60_000);
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const agentTab = page.getByRole('tab', { name: /^Ready/u });
  await expect(agentTab).toBeVisible();

  tunnelAvailable = false;
  await page.getByRole('button', { name: 'More options' }).click();

  const overlay = page.getByRole('alert', { name: 'Reconnecting to console' });
  await expect(overlay).toBeVisible();
  const [bounds, viewport] = await Promise.all([overlay.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBe(0);
  expect(bounds!.y).toBe(0);
  expect(bounds!.width).toBe(viewport.width);
  expect(bounds!.height).toBe(viewport.height);
  await expect(agentTab).toHaveCount(1);

  tunnelAvailable = true;
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(agentTab).toBeVisible();
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
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
        return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } }).catch(() => undefined);
      }
      return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
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
