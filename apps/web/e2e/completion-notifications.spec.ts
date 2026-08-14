import { expect, test } from '@playwright/test';

test('suppresses an intermediate completion when the next queued prompt starts', async ({ page }) => {
  test.setTimeout(45_000);
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
      const queuedPromptCount = dashboardRequests === 2 ? 1 : 0;
      return route.fulfill({
        json: {
          agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: working ? '⠋ Working' : 'Ready', worktreeLabel: 'Cora', queuedPromptCount }],
          worktrees: []
        }
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => dashboardRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: unknown[] }
  ).__testNotifications.length)).toBe(0);
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string }> }
  ).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Agent finished']);
});

test('notifies when the visible focused agent finishes', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  let dismissals = 0;
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    const sounds: string[] = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    Object.defineProperty(window, '__testSounds', { value: sounds });
    class TestNotification {
      static permission: NotificationPermission = 'granted';
    }
    class TestAudio {
      volume = 1;
      // retain each requested asset
      constructor(source: string) { sounds.push(source); }
      // allow deterministic playback
      async play() { return undefined; }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    Object.defineProperty(window, 'Audio', { configurable: true, value: TestAudio });
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
      return route.fulfill({
        json: {
          agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: dashboardRequests === 1 ? '⠋ Working' : 'Ready', worktreeLabel: 'Cora' }],
          worktrees: []
        }
      });
    }
    if (url.pathname === '/api/agents/agent-1/notifications/dismiss') {
      dismissals += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string }> }
  ).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Agent finished']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testSounds: string[] }).__testSounds)).toEqual(['/notification-success.wav']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.silent)).toBe(true);
  expect(dismissals).toBe(0);
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect.poll(() => dismissals).toBe(1);
});

test('uses a warning chime when an agent asks a question', async ({ page }) => {
  test.setTimeout(30_000);
  let dashboardRequests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    const sounds: string[] = [];
    Object.defineProperty(window, '__testNotifications', { value: notifications });
    Object.defineProperty(window, '__testSounds', { value: sounds });
    class TestNotification { static permission: NotificationPermission = 'granted'; }
    class TestAudio {
      volume = 1;
      // retain each requested asset
      constructor(source: string) { sounds.push(source); }
      // allow deterministic playback
      async play() { return undefined; }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    Object.defineProperty(window, 'Audio', { configurable: true, value: TestAudio });
    const registration = {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); }
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one authenticated client
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // transition from working to a question
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      const question = dashboardRequests === 1 ? undefined : { id: 'question-1', text: 'Choose a deployment target?', choices: ['Staging', 'Production'], paneId: '%1' };
      return route.fulfill({ json: { agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: question === undefined ? '⠋ Working' : 'Action required', worktreeLabel: 'Cora', question }], worktrees: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');

  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ title: string }> }).__testNotifications.map(notification => notification.title)), { timeout: 15_000 }).toEqual(['Agent has a question']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testSounds: string[] }).__testSounds)).toEqual(['/notification-warning.wav']);
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __testNotifications: Array<{ options?: NotificationOptions }> }).__testNotifications[0]?.options?.silent)).toBe(true);
});
