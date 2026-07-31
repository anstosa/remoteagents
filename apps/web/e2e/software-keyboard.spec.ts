import { expect, test } from '@playwright/test';

test('hides tabs only while an editable field has a software keyboard viewport', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 900 });
  await page.addInitScript(() => {
    let height = window.innerHeight;
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => height },
      offsetTop: { get: () => 0 },
      pageTop: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
      width: { get: () => window.innerWidth }
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, '__setVisualViewportHeight', {
      value: (next: number) => {
        height = next;
        viewport.dispatchEvent(new Event('resize'));
      }
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const tabs = page.getByRole('tablist');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(tabs).toBeVisible();

  await page.evaluate(() => (
    window as unknown as { __setVisualViewportHeight: (height: number) => void }
  ).__setVisualViewportHeight(500));
  await expect(tabs).toBeVisible();

  await page.evaluate(() => (
    window as unknown as { __setVisualViewportHeight: (height: number) => void }
  ).__setVisualViewportHeight(900));
  await prompt.focus();
  await page.evaluate(() => (
    window as unknown as { __setVisualViewportHeight: (height: number) => void }
  ).__setVisualViewportHeight(500));
  await expect(tabs).toBeHidden();

  await page.evaluate(() => (
    window as unknown as { __setVisualViewportHeight: (height: number) => void }
  ).__setVisualViewportHeight(900));
  await expect(tabs).toBeVisible();
});
