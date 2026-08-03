import { expect, test } from '@playwright/test';

test('reviews hourly runtime cleanup targets from the alert and glowing cleanup button', async ({ page }) => {
  test.setTimeout(45_000);
  let cleanupPending = 4;
  let submittedIds: string[] | undefined;
  const targets = [
    { id: 'worker-1', kind: 'orphan-worker', label: 'Orphan OMX worker', detail: 'worker-2 in tmux session feature-team' },
    { id: 'agent-1', kind: 'stale-agent', label: 'Stale Codex agent', detail: 'old-agent at /worktrees/removed' },
    { id: 'pane-1', kind: 'hud-pane', label: 'HUD watcher', detail: 'hud in tmux session monitoring' },
    { id: 'process-1', kind: 'hud-process', label: 'Detached HUD watcher', detail: 'Host process 4321: omx hud --watch' }
  ];

  await page.addInitScript(() => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    class TestNotification { static permission: NotificationPermission = 'granted'; }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); }
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending, agents: [{ id: 'current-agent', sessionId: 'socket:$1', workspace: '/worktrees/current', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/agents/current-agent/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/current-agent/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/cleanup' && request.method() === 'GET') return route.fulfill({ json: { targets } });
    if (url.pathname === '/api/cleanup' && request.method() === 'POST') {
      submittedIds = (request.postDataJSON() as { targetIds: string[] }).targetIds;
      cleanupPending = 0;
      return route.fulfill({ json: { targets: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/#cleanup');
  const dialog = page.getByRole('dialog', { name: 'Runtime cleanup' });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications)).toEqual([
    expect.objectContaining({ title: 'Runtime cleanup available', options: expect.objectContaining({ tag: 'runtime-cleanup', data: expect.objectContaining({ url: '/#cleanup' }) }) })
  ]);

  const cleanupButton = page.getByRole('button', { name: 'Review 4 cleanup targets' });
  await expect(cleanupButton).toBeVisible();
  await expect(cleanupButton).toHaveClass(/cleanup-toggle/);
  await expect(cleanupButton.locator('.cleanup-count')).toHaveText('4');
  await expect(dialog.getByText('Orphaned worker')).toBeVisible();
  await expect(dialog.getByText('Stale agent')).toBeVisible();
  await expect(dialog.getByText('HUD watcher window')).toBeVisible();
  await expect(dialog.getByText('HUD watcher', { exact: true })).toBeVisible();
  const checks = dialog.getByRole('checkbox');
  await expect(checks).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) await expect(checks.nth(index)).toBeChecked();

  await page.getByRole('button', { name: 'Close cleanup' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cleanupButton).toBeFocused();
  await cleanupButton.click();
  await expect(dialog).toBeVisible();

  for (let index = 0; index < 4; index += 1) await checks.nth(index).uncheck();
  await expect(dialog.getByRole('button', { name: 'Dismiss all' })).toBeVisible();
  await checks.nth(1).check();
  await checks.nth(3).check();
  await expect(dialog.getByRole('button', { name: 'Cleanup', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cleanup', exact: true }).click();
  await expect.poll(() => submittedIds).toEqual(['agent-1', 'process-1']);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.cleanup-toggle')).toHaveCount(0);
});
