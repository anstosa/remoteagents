import { expect, test } from '@playwright/test';

test('opens the configured project in a desktop browser split pane', async ({ page }) => {
  let previewLoads = 0;
  await page.setViewportSize({ width: 1280, height: 900 });
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
  await page.route('https://project.example.com/**', async route => {
    previewLoads += 1;
    await route.fulfill({ contentType: 'text/html', body: `<main>Project preview ${previewLoads}</main>` });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], tunnel: true } }], worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1, projectUrl: 'https://project.example.com' }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/delta/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const projectControls = page.getByRole('group', { name: 'Project controls' });
  await expect(projectControls.locator('.project-open + .project-browser-toggle + .project-stack-toggle')).toHaveCount(1);
  const split = page.getByRole('button', { name: 'Open project in split view' });
  await expect(split).toBeVisible();
  await split.click();

  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('toolbar', { name: 'Browser actions' })).toContainText('Browser');
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await expect(preview.locator('main')).toHaveText('Project preview 1');

  await browser.getByRole('button', { name: 'Use mobile viewport' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  const [frameWidth, shellWidth, paneWidth, outputWidth] = await Promise.all([
    browser.locator('iframe').evaluate(element => element.getBoundingClientRect().width),
    browser.locator('.browser-frame-shell').evaluate(element => element.getBoundingClientRect().width),
    browser.evaluate(element => element.getBoundingClientRect().width),
    page.locator('.log-output').evaluate(element => element.getBoundingClientRect().width)
  ]);
  expect(frameWidth).toBeLessThanOrEqual(391);
  expect(Math.abs(frameWidth - shellWidth)).toBeLessThanOrEqual(2);
  expect(paneWidth).toBeLessThanOrEqual(391);
  expect(outputWidth).toBeGreaterThan(paneWidth);

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await split.click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/desktop/u);
  await browser.getByRole('button', { name: 'Close browser' }).click();

  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await split.click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveText('Project preview 3');

  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(browser).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveText('Project preview 4');

  await page.reload();
  await expect(browser).toBeVisible();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveText('Project preview 5');

  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect(preview.locator('main')).toHaveText('Project preview 6');
  await browser.getByRole('button', { name: 'Enter browser fullscreen' }).click();
  await expect(browser).toHaveClass(/expanded/u);
  await expect(page.locator('.log-output')).toBeHidden();

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();

  await page.setViewportSize({ width: 428, height: 900 });
  await expect(split).toBeHidden();
});
