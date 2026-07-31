import { expect, test } from '@playwright/test';

test('long press selects mobile output without entering terminal input mode', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  const page = await context.newPage();
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
  await expect(page.getByLabel('Live log')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const dispatchPointer = (type: string, pointerId: number) => page.locator('.log-canvas').dispatchEvent(type, {
    bubbles: true,
    clientX: 80,
    clientY: 160,
    pointerId,
    pointerType: 'touch'
  });

  await dispatchPointer('pointerdown', 1);
  // A user may keep holding after the browser has started native selection.
  // The eventual release click must still belong to that long-press gesture.
  await page.waitForTimeout(1_300);
  await dispatchPointer('pointerup', 1);
  await page.locator('.log-canvas').dispatchEvent('click', { bubbles: true, clientX: 80, clientY: 160 });

  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await expect(page.locator('.terminal-frame.active .xterm-accessibility')).toHaveCSS('pointer-events', 'auto');
  await expect(page.locator('.terminal-frame.active .xterm-accessibility-tree')).toHaveCSS('user-select', 'text');

  await dispatchPointer('pointerdown', 2);
  await dispatchPointer('pointerup', 2);
  await page.locator('.log-canvas').dispatchEvent('click', { bubbles: true, clientX: 80, clientY: 160 });
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(page.locator('.prompt-composer')).toBeHidden();
  await expect(page.locator('.mobile-terminal-keys')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to prompt' })).toHaveCount(0);

  await context.close();
});
