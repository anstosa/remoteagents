import { expect, test } from '@playwright/test';

test('queues $fixup from a PR card with detected issues', async ({ page }) => {
  let queuedPrompt: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', pullRequest: { number: 42, title: 'Repair this PR', status: 'open', url: 'https://github.com/octo/repo/pull/42', issues: { failingChecks: true } } }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await page.getByRole('button', { name: 'Queue $fixup' }).click();

  await expect.poll(() => queuedPrompt).toEqual({ prompt: '$fixup', attachments: [] });
  await expect(page.getByRole('button', { name: 'Queue $fixup' })).toContainText('Queued');
});
