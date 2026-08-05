import { expect, test } from '@playwright/test';

test('output input mode forwards control keys without losing focus', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const frames: Array<{ url: string; data: string }> = [];
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
        });
      }
      send(data: string) { frames.push({ url: this.url, data }); }
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__terminalSocketFrames', { configurable: true, value: frames });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: `${String((request.postDataJSON() as { kind?: unknown }).kind)}-ticket` } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByLabel('Live log').click();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  await page.keyboard.press('Control+c');

  await expect.poll(async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).map(frame => JSON.parse(frame.data) as { data: string });
  })).toHaveLength(1);
  const [frame] = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(candidate => candidate.url.includes('/ws/input/')).map(candidate => JSON.parse(candidate.data) as { data: string });
  });
  expect(Buffer.from(frame!.data, 'base64url').toString('utf8')).toBe('\x03');
  await page.waitForTimeout(100);
  const frameCount = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).length;
  });
  expect(frameCount).toBe(1);

  // Output mode owns Ctrl+C even if browser chrome or a non-editable control
  // temporarily takes focus away from xterm.
  const pageUp = page.getByRole('button', { name: 'Page up' });
  await pageUp.focus();
  await page.keyboard.press('Control+c');
  await expect.poll(async () => (await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(candidate => candidate.url.includes('/ws/input/'));
  })).length).toBe(2);

  await pageUp.click();
  const backToBottom = page.getByRole('button', { name: 'Back to bottom' });
  const pageDown = page.getByRole('button', { name: 'Page down' });
  await expect(backToBottom).toBeVisible();
  await expect(backToBottom.locator('svg')).toBeVisible();
  await expect(backToBottom).toHaveText('');
  const [backToBottomBounds, pageDownBounds] = await Promise.all([backToBottom.boundingBox(), pageDown.boundingBox()]);
  expect(backToBottomBounds!.x).toBeLessThan(pageDownBounds!.x);
  expect(backToBottomBounds!.y).toBeCloseTo(pageDownBounds!.y, 0);
  await backToBottom.click();
  await expect(backToBottom).toBeHidden();

  await page.locator('.terminal-frame.active .xterm-helper-textarea').focus();

  await page.keyboard.press('Tab');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  await expect.poll(async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(candidate => candidate.url.includes('/ws/input/')).map(candidate => JSON.parse(candidate.data) as { data: string });
  })).toHaveLength(4);

  // The mobile Ctrl latch must produce ETX from the next software-keyboard c.
  await page.setViewportSize({ width: 428, height: 900 });
  await expect(page.getByLabel('Terminal keys')).toBeVisible();
  await page.locator('.terminal-frame.active .xterm-helper-textarea').focus();
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.keyboard.press('c');
  await expect.poll(async () => (await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(candidate => candidate.url.includes('/ws/input/'));
  })).length).toBe(5);

  const controlFrames = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(candidate => candidate.url.includes('/ws/input/')).map(candidate => JSON.parse(candidate.data) as { data: string });
  });
  expect(controlFrames.map(controlFrame => Buffer.from(controlFrame.data, 'base64url').toString('utf8'))).toEqual(['\x03', '\x03', '\t', '\x1b[Z', '\x03']);
});
