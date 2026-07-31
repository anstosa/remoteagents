import { expect, test } from '@playwright/test';

test('expands and collapses an overflowing last prompt', async ({ page }) => {
  const longPrompt = 'Review every changed service and explain the deployment risk before making any edits. '.repeat(8);
  await page.setViewportSize({ width: 428, height: 952 });
  await page.addInitScript(prompt => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
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
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) {
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\\n', lastPrompt: prompt }) }));
          }
        });
      }
      send() {}
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, longPrompt);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.locator('.last-prompt');
  await expect(prompt).toContainText(longPrompt);
  await expect(prompt).toHaveAttribute('role', 'button');
  await expect(prompt).toHaveAttribute('aria-expanded', 'false');
  const collapsedHeight = await prompt.evaluate(element => element.getBoundingClientRect().height);

  await prompt.click();
  await expect(prompt).toHaveAttribute('aria-expanded', 'true');
  await expect(prompt).toHaveClass(/expanded/u);
  const expandedHeight = await prompt.evaluate(element => element.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(collapsedHeight * 2);

  await prompt.press('Enter');
  await expect(prompt).toHaveAttribute('aria-expanded', 'false');
  await expect(prompt).not.toHaveClass(/expanded/u);
});
