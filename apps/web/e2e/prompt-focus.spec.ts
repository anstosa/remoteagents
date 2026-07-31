import { expect, test } from '@playwright/test';

test('focusing the prompt releases output input focus', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const output = page.getByLabel('Live log');
  const log = page.locator('.log');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(output).toBeVisible();

  await output.click();
  await expect(log).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  await prompt.focus();
  await expect(prompt).toBeFocused();
  await expect(log).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
});
