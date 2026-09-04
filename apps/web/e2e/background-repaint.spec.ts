import { expect, test } from '@playwright/test';

// Regression: a backgrounded window pauses requestAnimationFrame while the log
// socket keeps delivering frames. The double-buffer swap runs on setTimeout-based
// xterm write callbacks, so several deferred "reset the previous buffer" closures
// queue up; when rAF resumes, a stale reset must not clear the buffer that has
// since become the active/visible one. An idle Claude pane then sends no further
// frames (the server dedups an unchanged capture), so a clobbered blank would
// stick until the operator forces a redraw.

test('keeps the latest frame visible after a backgrounded burst resumes', async ({ page }) => {
  await page.addInitScript(() => {
    // Controllable rAF: real callbacks, held in a queue we flush on demand so we
    // can model a background tab (rAF paused, timers still firing).
    const rafQueue: FrameRequestCallback[] = [];
    let rafId = 0;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    let paused = false;
    (window as any).__flushRAF = () => { const batch = rafQueue.splice(0); for (const cb of batch) { try { cb(performance.now()); } catch {} } return batch.length; };
    (window as any).__pauseRAF = () => { paused = true; };
    (window as any).__resumeRAF = () => { paused = false; };
    window.requestAnimationFrame = (cb: FrameRequestCallback) => { if (paused) { rafQueue.push(cb); return ++rafId; } return nativeRaf(cb); };

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
      constructor(url: string | URL) { this.url = String(url); sockets.push(this); }
      send() {}
      close() { if (this.readyState === MockWebSocket.CLOSED) return; this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    const logSocket = () => sockets.find(s => s.url.includes('/ws/logs/agent-1'));
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__openLogSocket', { value: () => { const s = logSocket(); if (s === undefined) return false; s.readyState = MockWebSocket.OPEN; s.onopen?.(new Event('open')); return true; } });
    Object.defineProperty(window, '__emitLogFrame', { value: (text: string, metadata?: boolean) => {
      const frame: Record<string, unknown> = { v: 1, type: 'reset', text, older: false, newer: false };
      if (metadata) frame.metadata = { state: 'complete', latestAgentMessage: null, latestAssistantMessage: null, latestAssistantMessageOverflows: false };
      logSocket()?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
    } });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as any).__openLogSocket())).toBe(true);

  // Land an initial painted frame the normal way.
  await page.evaluate(() => (window as any).__emitLogFrame('PAINT-0'));
  await expect(page.locator('.terminal-frame.active .xterm-rows')).toContainText('PAINT-0');

  // Background the window: pause rAF, deliver changed frames (write callbacks are
  // timer-based and keep swapping buffers), then foreground: resume + flush rAF.
  await page.evaluate(() => (window as any).__pauseRAF());
  await page.evaluate(() => (window as any).__emitLogFrame('BG-1'));
  await page.waitForTimeout(60);
  await page.evaluate(() => (window as any).__emitLogFrame('BG-2'));
  await page.waitForTimeout(60);
  await page.evaluate(() => { (window as any).__resumeRAF(); (window as any).__flushRAF(); });
  await page.waitForTimeout(60);
  await page.evaluate(() => (window as any).__flushRAF());

  // Steady-state Claude re-sends the identical capture; the client dedups it, so
  // nothing forces a redraw. The latest content must already be visible.
  await page.evaluate(() => (window as any).__emitLogFrame('BG-2', true));

  await expect(page.locator('.terminal-frame.active .xterm-rows')).toContainText('BG-2');
});
