import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';

// The soft-keyboard treatment: the tablist hides when the keyboard shrinks the viewport
// while the composer or the pane is focused, and returns when the keyboard closes; streamed
// output arriving while typing never steals focus; and the split-view browser keeps the
// output full-width across keyboard-driven aspect changes.

test('hides the tablist under the keyboard and keeps pane focus across streamed output', async ({ page }) => {
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
      value: (next: number) => { height = next; viewport.dispatchEvent(new Event('resize')); }
    });
  });
  await installPaneMock(page);
  await page.route('https://project.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Project preview</main>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', projectUrl: 'https://project.example.com', stack: { running: true, tunnel: true }, queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  const setViewportHeight = (next: number) => page.evaluate(height => (window as unknown as { __setVisualViewportHeight: (height: number) => void }).__setVisualViewportHeight(height), next);

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  const tabs = page.getByRole('tablist');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(tabs).toBeVisible();

  // A shrink with nothing focused is not a keyboard; tabs stay.
  await setViewportHeight(500);
  await expect(tabs).toBeVisible();
  await setViewportHeight(900);

  // Composer focus + shrink hides the tabs; restoring the height brings them back.
  await prompt.focus();
  await setViewportHeight(500);
  await expect(tabs).toBeHidden();
  await setViewportHeight(900);
  await expect(tabs).toBeVisible();

  // Focusing the pane and shrinking hides the tabs too.
  const output = page.getByLabel('Live log');
  const terminalInput = page.locator('.log-canvas .xterm-helper-textarea');
  await output.locator('.xterm-screen').click();
  await expect(terminalInput).toBeFocused();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await setViewportHeight(500);
  await expect(tabs).toBeHidden();

  // Streamed output while typing never steals focus.
  await pushBytes(page, 'agent-1', 'Updated output while typing\r\n');
  await expect(terminalInput).toBeFocused();
  await expect(page.locator('.log-output')).toHaveClass(/input-active/u);
  await expect(tabs).toBeHidden();

  // Closing the keyboard restores the tabs.
  await setViewportHeight(900);
  await expect(tabs).toBeVisible();

  // The split-view browser keeps the output full-width across keyboard aspect changes.
  await page.setViewportSize({ width: 900, height: 1200 });
  await setViewportHeight(1200);
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect.poll(() => output.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(899);
  await prompt.focus();
  await setViewportHeight(500);
  await expect(browser).toBeHidden();
  await expect.poll(() => output.evaluate(element => element.getBoundingClientRect().right)).toBeGreaterThanOrEqual(899);
  await setViewportHeight(1200);
  await expect(browser).toBeVisible();
});
