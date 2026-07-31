import { expect, test } from '@playwright/test';

test('broadcasts dismissal when a worktree agent becomes the focused UI', async ({ page }) => {
  const remoteDismissals: string[] = [];
  await page.addInitScript(() => {
    const localDismissals: string[] = [];
    Object.defineProperty(window, '__localDismissals', { configurable: true, value: localDismissals });
    const registration = {
      getNotifications: async ({ tag }: { tag?: string } = {}) => [{ close: () => { if (tag) localDismissals.push(tag); } }],
      showNotification: async () => {}
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration }
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready' }
    ], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/notifications\/dismiss$/u.test(url.pathname) && request.method() === 'POST') {
      remoteDismissals.push(url.pathname);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.bringToFront();
  await expect.poll(() => remoteDismissals).toContain('/api/agents/agent-1/notifications/dismiss');
  await page.getByRole('tab', { name: /^Owen/u }).click();
  await expect.poll(() => remoteDismissals).toContain('/api/agents/agent-2/notifications/dismiss');
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __localDismissals: string[] }
  ).__localDismissals)).toEqual(expect.arrayContaining(['worktree-status-cora', 'agent-status-agent-1', 'worktree-status-owen', 'agent-status-agent-2']));
});

test('service worker closes matching worktree notifications without showing another alert', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const closed: string[] = [];
    const shown: string[] = [];
    const notifications = [
      { tag: 'worktree-status-cora', data: { worktreeId: 'cora' }, close: () => closed.push('stable') },
      { tag: 'agent-status-old-pane', data: { worktreeId: 'cora' }, close: () => closed.push('old-pane') },
      { tag: 'worktree-status-owen', data: { worktreeId: 'owen' }, close: () => closed.push('other') }
    ];
    Object.defineProperty(window, 'registration', { configurable: true, value: { getNotifications: async () => notifications, showNotification: async (title: string) => { shown.push(title); } } });
    Object.defineProperty(window, 'clients', { configurable: true, value: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } });
    Object.defineProperty(window, 'skipWaiting', { configurable: true, value: () => {} });
    const source = await fetch('/sw.js').then(response => response.text());
    Function(source)();
    const waits: Promise<unknown>[] = [];
    const event = new Event('push') as Event & { data: { json: () => unknown }; waitUntil: (promise: Promise<unknown>) => void };
    Object.defineProperty(event, 'data', { value: { json: () => ({ kind: 'dismiss', tag: 'worktree-status-cora', legacyTag: 'agent-status-current-pane', worktreeId: 'cora' }) } });
    Object.defineProperty(event, 'waitUntil', { value: (promise: Promise<unknown>) => waits.push(promise) });
    window.dispatchEvent(event);
    await Promise.all(waits);
    return { closed, shown };
  });

  expect(result).toEqual({ closed: ['stable', 'old-pane'], shown: [] });
});
