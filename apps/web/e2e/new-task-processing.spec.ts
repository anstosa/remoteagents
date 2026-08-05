import { expect, test } from '@playwright/test';

test('keeps a new-task processing indicator visible until the replacement agent appears', async ({ page }) => {
  let oldAgentGone = false;
  let replacementReady = false;
  let dashboardRequests = 0;
  let finishNewTask!: () => void;
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      if (replacementReady) return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, newTaskConfigured: true, title: 'Ready' }], worktrees: [] } });
      if (oldAgentGone) return route.fulfill({ json: { generation: dashboardRequests, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0 }] } });
      return route.fulfill({ json: { generation: dashboardRequests, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, newTaskConfigured: true, title: 'Ready' }], worktrees: [] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') return route.fulfill({ json: { enabled: true } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'POST') {
      await newTaskFinished;
      replacementReady = true;
      return route.fulfill({ status: 202 });
    }
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.locator('.more-menu').getByRole('button', { name: 'New Task', exact: true }).click();

  const processing = page.getByRole('status', { name: 'Starting new task' });
  await expect(processing).toBeVisible();
  await expect(processing).toContainText('preparing a fresh agent');
  await expect(page.getByRole('status').filter({ hasText: 'Starting a new task' })).toContainText('You can keep using other tabs');
  await expect(page.getByRole('tab', { name: 'Cora — Starting new task' })).toHaveAttribute('aria-busy', 'true');

  oldAgentGone = true;
  const requestsBeforeRemoval = dashboardRequests;
  await expect.poll(() => dashboardRequests, { timeout: 10_000 }).toBeGreaterThan(requestsBeforeRemoval);
  await expect(page.getByRole('tab', { name: 'Cora — Starting new task' })).toBeVisible();
  await expect(processing).toBeVisible();

  finishNewTask();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(processing).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'New task is ready' })).toContainText('ready for a fresh prompt');
});
