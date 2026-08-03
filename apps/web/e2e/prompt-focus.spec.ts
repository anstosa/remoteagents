import { expect, test } from '@playwright/test';

test('focusing and submitting the prompt keeps keyboard input in the composer', async ({ page }) => {
  let finishPromptRequest: (() => void) | undefined;
  const promptRequestFinished = new Promise<void>(resolve => { finishPromptRequest = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      await promptRequestFinished;
      return route.fulfill({ json: { ok: true } });
    }
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
  await prompt.fill('Keep this prompt');
  await prompt.press('Control+c');
  await expect(prompt).toHaveValue('Keep this prompt');

  await prompt.fill('Queue this prompt');
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('');
  await expect(prompt).toBeFocused();
  await prompt.fill('Start the next prompt immediately');
  finishPromptRequest?.();
  await expect(prompt).toHaveValue('Start the next prompt immediately');
  await expect(prompt).toBeFocused();
});
