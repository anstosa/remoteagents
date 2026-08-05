import { expect, test } from '@playwright/test';

test('manages waiting prompts from the clock control connected to Queue', async ({ page }) => {
  const requested: string[] = [];
  const queued = [
    { id: 'queued-prompt-001', text: 'First queued prompt', createdAt: '2026-08-04T01:00:00.000Z' },
    { id: 'queued-prompt-002', text: 'Second queued prompt', createdAt: '2026-08-04T01:01:00.000Z', attachments: [{ name: 'context.txt', size: 7 }] }
  ];
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requested.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', title: '⠋ Working' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: queued } });
    const match = /^\/api\/agents\/agent-1\/queued-prompts\/([^/]+)(\/move)?$/u.exec(url.pathname);
    if (match?.[2] === '/move' && request.method() === 'POST') {
      const index = queued.findIndex(prompt => prompt.id === match[1]);
      const direction = (request.postDataJSON() as { direction: 'earlier' | 'later' }).direction;
      const next = direction === 'earlier' ? index - 1 : index + 1;
      if (index >= 0 && next >= 0 && next < queued.length) [queued[index], queued[next]] = [queued[next]!, queued[index]!];
      return route.fulfill({ json: { prompts: queued } });
    }
    if (match && request.method() === 'PUT') {
      const prompt = queued.find(candidate => candidate.id === match[1]);
      if (prompt === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      prompt.text = (request.postDataJSON() as { prompt: string }).prompt;
      return route.fulfill({ json: prompt });
    }
    if (match && request.method() === 'DELETE') {
      const index = queued.findIndex(prompt => prompt.id === match[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      queued.splice(index, 1);
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const prompt = (request.postDataJSON() as { prompt: string }).prompt;
      queued.push({ id: `queued-prompt-00${queued.length + 1}`, text: prompt, createdAt: '2026-08-04T01:02:00.000Z' });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => requested).toContain('GET /api/agents/agent-1/queued-prompts');
  const queue = page.getByRole('button', { name: 'Queue', exact: true });
  const clock = page.getByRole('button', { name: 'Queued prompts (2)' });
  await expect(clock).toBeVisible();
  const [queueBounds, clockBounds] = await Promise.all([queue.boundingBox(), clock.boundingBox()]);
  expect(Math.abs(queueBounds!.x + queueBounds!.width - clockBounds!.x)).toBeLessThanOrEqual(1);

  await clock.click();
  const menu = page.getByLabel('Queued prompts', { exact: true });
  const copies = menu.locator('.queued-prompt-copy');
  const positions = menu.locator('.queued-prompt-position');
  await expect(copies).toHaveCount(2);
  await expect(copies.first()).toContainText('First queued prompt');
  await expect(copies.last()).toContainText('Second queued prompt');
  await expect(copies.last()).toContainText('context.txt');
  await expect(positions).toHaveText(['1', '2']);
  await expect(menu).not.toContainText('Oldest runs first');
  const [menuBounds, viewportWidth] = await Promise.all([menu.boundingBox(), page.evaluate(() => innerWidth)]);
  expect(menuBounds!.width).toBeGreaterThanOrEqual(viewportWidth - 17);
  expect(menuBounds!.width).toBeLessThanOrEqual(viewportWidth - 15);

  await page.getByRole('button', { name: 'Move queued prompt earlier: Second queued prompt' }).click();
  await expect(copies.first()).toContainText('Second queued prompt');
  await expect(positions).toHaveText(['1', '2']);
  await page.getByRole('button', { name: 'Edit queued prompt: Second queued prompt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit queued prompt: Second queued prompt' });
  await editor.fill('Edited queued prompt');
  await page.getByRole('button', { name: 'Save queued prompt: Second queued prompt' }).click();
  await expect(copies.first()).toContainText('Edited queued prompt');

  await page.getByRole('button', { name: 'Cancel queued prompt: Edited queued prompt' }).click();
  await expect(page.getByRole('button', { name: 'Queued prompts (1)' })).toBeVisible();
  await expect(copies).toHaveCount(1);

  await page.getByRole('textbox', { name: 'Prompt' }).fill('Third queued prompt');
  await queue.click();
  const updatedClock = page.getByRole('button', { name: 'Queued prompts (2)' });
  await expect(updatedClock).toBeVisible();
  if (!await menu.isVisible()) await updatedClock.click();
  await expect(menu).toBeVisible();
  await expect(copies.last()).toContainText('Third queued prompt');
});
