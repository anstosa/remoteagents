import { expect, test } from '@playwright/test';

test('shows cached agent output immediately while a selected tab reconnects', async ({ page }) => {
  await page.addInitScript(() => {
    const sockets: MockWebSocket[] = [];
    // expose deterministic log sockets
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
      constructor(url: string | URL) { this.url = String(url); sockets.push(this); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__cacheAgentOutput', {
      // populate the background snapshot
      value: (id: string, text: string) => {
        const socket = sockets.find(candidate => candidate.url.includes(`/ws/logs/${id}`));
        // wait for background prefetch
        if (socket === undefined) return false;
        socket.readyState = MockWebSocket.OPEN;
        socket.onopen?.(new Event('open'));
        socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text }) }));
        return true;
      }
    });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve the active session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve two selectable agents
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/one', worktreeLabel: 'One', worktreeOrder: 1, title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/two', worktreeLabel: 'Two', worktreeOrder: 2, title: 'Ready' }
    ], worktrees: [] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // issue live-output tickets
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt resources
    if (/^\/api\/agents\/agent-[12]\/(?:skills|saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: url.pathname.endsWith('/skills') ? { skills: [] } : { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cacheAgentOutput: (id: string, text: string) => boolean }).__cacheAgentOutput('agent-2', 'Cached output for Two'))).toBe(true);

  await page.getByRole('tab', { name: /^Two/u }).click();
  await expect(page.locator('.terminal-frame.active .xterm-rows')).toContainText('Cached output for Two');
  await expect(page.locator('.log-status')).toHaveText('Cached');
  await expect(page.locator('.log-stale-overlay')).toHaveCount(0);
});
