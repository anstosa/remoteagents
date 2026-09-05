import { expect, test, type Page } from '@playwright/test';

// capture browser notifications without requesting permission
async function captureNotifications(page: Page) {
  await page.addInitScript(() => {
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { configurable: true, value: notifications });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); }
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });
}

// serve the minimum authenticated console shell
async function serveConsole(page: Page, updates: unknown[], serverUpdate: { available: boolean; commitCount: number; targetSha?: string }) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render settings on an empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'both', turnCapture: true, bookmarks: true, inlineQuestions: true, commands: true, sandbox: false } }, agents: [], projects: [] } });
    // expose configured agent versions
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: updates } });
    // expose the upstream commit count
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: serverUpdate });
    // disable subscription writes
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('announces agent updates and opens settings from the notification route', async ({ page }) => {
  await captureNotifications(page);
  await serveConsole(page, [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }], { available: false, commitCount: 0 });

  await page.goto('/');

  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications)).toEqual([
    expect.objectContaining({ title: 'Codex update available', options: expect.objectContaining({ body: '0.152.1 -> 0.153.2', tag: 'agent-update-codex', data: expect.objectContaining({ url: '/#settings' }) }) })
  ]);
  await page.evaluate(() => { location.hash = '#settings'; });
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});

test('announces upstream Remote Agent Console commits', async ({ page }) => {
  await captureNotifications(page);
  await serveConsole(page, [], { available: true, commitCount: 3, targetSha: '3'.repeat(40) });

  await page.goto('/');

  await expect.poll(async () => await page.evaluate(() => (window as typeof window & { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }).__testNotifications)).toEqual([
    expect.objectContaining({ title: 'Remote Agent Console update available', options: expect.objectContaining({ body: '3 commits upstream', tag: 'rac-update', data: expect.objectContaining({ url: '/#server-update' }) }) })
  ]);
});
