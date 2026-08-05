import { expect, test } from '@playwright/test';

test('keeps agent on/off progress visible across lifecycle transitions', async ({ page }) => {
  let agentRunning = true;
  let agentId = 'agent-1';
  let finishDeactivate!: () => void;
  let finishLaunch!: () => void;
  const deactivateFinished = new Promise<void>(resolve => { finishDeactivate = resolve; });
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: agentRunning
          ? { generation: 1, agents: [{ id: agentId, sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], worktrees: [] }
          : { generation: 2, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0 }] }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/deactivate' && request.method() === 'POST') {
      await deactivateFinished;
      agentRunning = false;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/worktrees/cora/launch' && request.method() === 'POST') {
      await launchFinished;
      agentRunning = true;
      agentId = 'agent-2';
      return route.fulfill({ json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Turn off worktree agent' }).click();

  const pendingOff = page.getByRole('status').filter({ hasText: 'Turning off Cora' });
  await expect(pendingOff).toContainText('Stopping the agent while keeping the worktree available');
  await expect(page.getByRole('tab', { name: 'Cora — Turning off' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Turn off worktree agent' })).toBeDisabled();

  finishDeactivate();
  const offSuccess = page.getByRole('status').filter({ hasText: 'Cora is off' });
  await expect(offSuccess).toContainText('Launch agent whenever you want to turn it back on');
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByText('Agent is off', { exact: true })).toBeVisible();

  await page.locator('.prompt-actions').getByRole('button', { name: 'Launch agent' }).click();
  const pendingLaunch = page.getByRole('status').filter({ hasText: 'Starting Cora' });
  await expect(pendingLaunch).toContainText('waiting for the agent session to become ready');
  await expect(page.getByRole('tab', { name: 'Cora — Starting agent' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Starting Codex…', { exact: true })).toBeVisible();

  finishLaunch();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is starting' })).toContainText('output is connecting');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});
