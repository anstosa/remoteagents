import { expect, test } from '@playwright/test';

test('keeps the software keyboard open across output refreshes and closes it on a second tap', async ({ page }) => {
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
    const sockets: MockWebSocket[] = [];
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
        sockets.push(this);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
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
    Object.defineProperty(window, '__emitLogReset', {
      value: (text: string) => sockets.find(socket => socket.url.includes('/ws/logs/'))?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text }) }))
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: `${String((request.postDataJSON() as { kind?: unknown }).kind)}-ticket` } });
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

  const output = page.getByLabel('Live log');
  const terminalInput = page.locator('.terminal-frame.active .xterm-helper-textarea');
  await output.dispatchEvent('click');
  await expect(terminalInput).toBeFocused();
  await page.evaluate(() => (
    window as unknown as { __setVisualViewportHeight: (height: number) => void }
  ).__setVisualViewportHeight(500));
  await expect(tabs).toBeHidden();

  await page.evaluate(() => (
    window as unknown as { __emitLogReset: (text: string) => void }
  ).__emitLogReset('Updated output while typing'));
  await expect(terminalInput).toBeFocused();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(tabs).toBeHidden();

  await output.dispatchEvent('click');
  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await expect(tabs).toBeVisible();
});
