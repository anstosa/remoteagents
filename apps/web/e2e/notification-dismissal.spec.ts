import { expect, test } from '@playwright/test';

test('dismisses a newly selected agent tab but waits for prompt focus on the already active tab', async ({ page }) => {
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
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', unread: true },
      { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', worktreeOrder: 1, title: 'Ready', unread: true }
    ], projects: [] } });
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
  await expect.poll(() => remoteDismissals).toEqual([]);
  const activeUnread = page.getByRole('tab', { name: 'Cora — Prompt done — Unread' });
  await expect(activeUnread).toHaveClass(/unread/u);
  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContain('/api/agents/agent-1/notifications/dismiss');
  const unread = page.getByRole('tab', { name: 'Owen — Prompt done — Unread' });
  await expect(unread).toHaveClass(/unread/u);
  await expect(unread).toHaveCSS('animation-name', 'tab-unread-success');
  await unread.click();
  await expect(page.getByRole('tab', { name: 'Owen — Prompt done' })).not.toHaveClass(/unread/u);
  await expect.poll(() => remoteDismissals).toContain('/api/agents/agent-2/notifications/dismiss');
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __localDismissals: string[] }
  ).__localDismissals)).toEqual(expect.arrayContaining(['worktree-status-owen', 'agent-status-agent-2']));
});
