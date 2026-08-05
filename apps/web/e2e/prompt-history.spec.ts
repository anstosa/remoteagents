import { expect, test } from '@playwright/test';

test('shows worktree prompt history and cycles it from the composer', async ({ page }) => {
  const history = [
    { id: 'history-entry-002', text: 'Second prompt', createdAt: '2026-08-04T01:02:00.000Z' },
    { id: 'history-entry-001', text: 'First prompt', createdAt: '2026-08-04T01:01:00.000Z' }
  ];
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\n', lastPrompt: 'Second prompt' }) }));
        });
      }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history' && request.method() === 'GET') return route.fulfill({ json: { prompts: history } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const prompt = (request.postDataJSON() as { prompt: string }).prompt;
      history.unshift({ id: `history-entry-${history.length + 1}`.padStart(17, '0'), text: prompt, createdAt: '2026-08-04T01:03:00.000Z' });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.addStyleTag({ content: '.prompt-history-list { max-height: 5rem; } .prompt-history-list button { min-height: 4rem; }' });
  await expect(page.getByRole('button', { name: 'Last prompt', exact: true })).toContainText('Second prompt');
  const historyToggle = page.getByRole('button', { name: 'Prompt history (2)' });
  await expect(historyToggle).toBeVisible();
  await historyToggle.click();
  const historyMenu = page.getByLabel('Prompt history', { exact: true });
  await expect(historyMenu).toBeVisible();
  await expect(historyMenu.getByRole('button')).toHaveCount(2);
  await expect(historyMenu.getByRole('button').first()).toContainText('First prompt');
  await expect(historyMenu.getByRole('button').last()).toContainText('Second prompt');
  await expect.poll(() => historyMenu.locator('.prompt-history-list').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);

  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.click();
  await expect(historyMenu).toBeHidden();
  await composer.fill('Current draft');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Current draft');

  await historyToggle.click();
  await expect.poll(() => historyMenu.locator('.prompt-history-list').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
  await historyMenu.getByRole('button').first().click();
  await expect(composer).toHaveValue('First prompt');
  await expect(historyMenu).toBeHidden();

  await composer.fill('Third prompt');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const updatedHistoryToggle = page.getByRole('button', { name: 'Prompt history (3)' });
  await expect(updatedHistoryToggle).toBeVisible();
  await updatedHistoryToggle.click();
  await expect(historyMenu.getByRole('button').first()).toContainText('First prompt');
  await expect(historyMenu.getByRole('button').last()).toContainText('Third prompt');
  await expect.poll(() => historyMenu.locator('.prompt-history-list').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
});
