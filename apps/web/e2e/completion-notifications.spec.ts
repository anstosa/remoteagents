import { expect, test } from '@playwright/test';

test('suppresses an intermediate completion when the next queued prompt starts', async ({ page }) => {
  let dashboardRequests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    class TestNotification {
      static permission: NotificationPermission = 'granted';
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => {
        notifications.push({ title, options });
      }
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      const working = dashboardRequests === 1 || dashboardRequests === 3 || dashboardRequests === 4;
      return route.fulfill({
        json: {
          agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: working ? '⠋ Working' : 'Ready', worktreeLabel: 'Cora' }],
          worktrees: []
        }
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => dashboardRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: unknown[] }
  ).__testNotifications.length)).toBe(0);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string }> }
  ).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Agent finished']);
});
