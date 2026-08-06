import { expect, test } from '@playwright/test';

test('copies a note and sends its current contents as a prompt', async ({ page }) => {
  let copied = '';
  let queuedPrompt: { prompt: string; attachments: unknown[] } | undefined;
  const note = { id: 'note-identifier-001', text: '' };

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as unknown as { __copiedNote: string }).__copiedNote = value; } }
    });
    Object.defineProperty(window, '__copiedNote', { configurable: true, writable: true, value: '' });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') return route.fulfill({ status: 201, json: note });
    if (url.pathname === `/api/worktrees/cora/notes/${note.id}` && request.method() === 'PUT') {
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (0)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Note' });
  const editor = dialog.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Use this exact note as the next prompt.');

  const copyButton = dialog.getByRole('button', { name: 'Copy note' });
  await expect(copyButton).toHaveText('');
  await expect(copyButton.locator('svg')).toBeVisible();
  await copyButton.click();
  const copiedButton = dialog.getByRole('button', { name: 'Note copied' });
  await expect(copiedButton).toHaveText('');
  await expect(copiedButton.locator('path')).toHaveAttribute('d', 'm5 12 4 4L19 6');
  await expect(dialog.getByText('Copied', { exact: true })).toHaveCount(0);
  copied = await page.evaluate(() => (window as unknown as { __copiedNote: string }).__copiedNote);
  expect(copied).toBe('Use this exact note as the next prompt.');
  await expect(dialog.getByRole('button', { name: 'Copy note' })).toBeVisible({ timeout: 3_000 });

  const send = dialog.getByRole('button', { name: 'Send note as prompt' });
  await expect(send.locator('svg')).toBeVisible();
  await expect(send).toHaveCSS('background-image', /linear-gradient/);
  await send.click();
  await expect.poll(() => queuedPrompt).toEqual({ prompt: 'Use this exact note as the next prompt.', attachments: [] });
  await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
});
