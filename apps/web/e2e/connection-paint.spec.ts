import { expect, test } from '@playwright/test';

test('keeps output connecting until the first fresh frame has painted', async ({ page }) => {
  await page.addInitScript(() => {
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
      }
      send() {}
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    const logSocket = () => sockets.find(socket => socket.url.includes('/ws/logs/agent-1'));
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__openLogSocket', {
      value: () => {
        const socket = logSocket();
        if (socket === undefined) return false;
        socket.readyState = MockWebSocket.OPEN;
        socket.onopen?.(new Event('open'));
        return true;
      }
    });
    Object.defineProperty(window, '__emitLogFrame', {
      value: (text: string) => logSocket()?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text }) }))
    });
    Object.defineProperty(window, '__connectionOrder', { configurable: true, value: [] as string[] });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const status = page.locator('.log-status');
  const staleOverlay = page.locator('.log-stale-overlay');
  await expect(status).toHaveText('Connecting');
  await expect(staleOverlay).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openLogSocket: () => boolean }).__openLogSocket())).toBe(true);
  await expect(status).toHaveText('Connecting');
  await expect(staleOverlay).toBeVisible();

  await page.evaluate(() => {
    const order = (window as unknown as { __connectionOrder: string[] }).__connectionOrder;
    let outputRecorded = false;
    let liveRecorded = false;
    const record = () => {
      const output = document.querySelector('.terminal-frame.active .xterm-rows')?.textContent ?? '';
      const currentStatus = document.querySelector('.log-status')?.textContent;
      if (!outputRecorded && output.includes('Fresh output paint')) {
        outputRecorded = true;
        requestAnimationFrame(() => order.push('paint'));
      }
      if (!liveRecorded && currentStatus === 'Live') {
        liveRecorded = true;
        order.push('live');
      }
    };
    new MutationObserver(record).observe(document.body, { childList: true, characterData: true, subtree: true });
    (window as unknown as { __emitLogFrame: (text: string) => void }).__emitLogFrame('Fresh output paint');
  });

  await expect(page.locator('.terminal-frame.active .xterm-rows')).toContainText('Fresh output paint');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __connectionOrder: string[] }).__connectionOrder)).toEqual(['paint', 'live']);
  await expect(status).toHaveText('Live');
  await expect(staleOverlay).toHaveCount(0);
});
