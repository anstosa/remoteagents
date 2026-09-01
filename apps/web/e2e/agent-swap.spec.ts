import { expect, test } from '@playwright/test';

test('backgrounds an idle agent and swaps the output area to its interactive terminal', async ({ page }) => {
  const ticketKinds: string[] = [];
  let backgroundRequests = 0;
  let foregroundRequests = 0;
  let promptRequests = 0;
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', kind: 'codex', attention: 'finished' }, { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', title: 'Second', kind: 'claude', attention: 'finished' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/background') {
      backgroundRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/foreground') {
      foregroundRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/prompt') {
      promptRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) {
      const payload = request.postDataJSON() as { kind?: unknown };
      if (typeof payload.kind === 'string') ticketKinds.push(payload.kind);
      return route.fulfill({ json: { ticket: `${String(payload.kind)}-ticket` } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open terminal' })).toHaveCount(0);
  await expect(page.locator('.prompt-actions > .swap-agent')).toHaveCount(0);
  const swapFromMenu = async () => {
    await page.getByRole('button', { name: 'More options' }).click();
    const swap = page.locator('.more-menu').getByRole('button', { name: 'Swap to terminal' });
    await expect(swap).toBeEnabled();
    await expect(swap.locator('.more-menu-icon')).toHaveCount(1);
    await swap.click();
  };
  await swapFromMenu();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();
  const returnToAgent = page.getByRole('button', { name: 'Return to agent output' });
  await expect(returnToAgent).toBeVisible();
  await expect(returnToAgent).toHaveClass(/swap-agent/u);
  await expect(page.getByRole('button', { name: 'Swap to terminal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue' })).toHaveCount(0);
  const enter = page.getByRole('button', { name: 'Enter', exact: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(enter).toBeEnabled();
  await prompt.fill('printf terminal-mode');
  await enter.click();
  await expect(prompt).toHaveValue('');
  await expect.poll(async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).map(frame => JSON.parse(frame.data) as { data: string });
  })).toHaveLength(1);
  const [inputFrame] = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).map(frame => JSON.parse(frame.data) as { data: string });
  });
  expect(Buffer.from(inputFrame!.data, 'base64url').toString('utf8')).toBe('printf terminal-mode\r');
  await enter.click();
  await expect.poll(async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).length;
  })).toBe(2);
  const inputFrames = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).map(frame => JSON.parse(frame.data) as { data: string });
  });
  expect(Buffer.from(inputFrames[1]!.data, 'base64url').toString('utf8')).toBe('\r');
  expect(promptRequests).toBe(0);
  await expect.poll(() => backgroundRequests).toBe(1);
  await expect.poll(() => ticketKinds.filter(kind => kind === 'logs').length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => ticketKinds.filter(kind => kind === 'input').length).toBe(1);
  expect(ticketKinds).not.toContain('terminal');

  await returnToAgent.click();
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect.poll(() => backgroundRequests).toBe(1);
  await expect.poll(() => foregroundRequests).toBe(1);

  // forward blank Enter from the normal prompt to the agent output
  await prompt.press('Enter');
  await expect.poll(async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).length;
  })).toBe(3);
  const forwardedFrames = await page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames.filter(frame => frame.url.includes('/ws/input/')).map(frame => JSON.parse(frame.data) as { data: string });
  });
  expect(Buffer.from(forwardedFrames[2]!.data, 'base64url').toString('utf8')).toBe('\r');
  expect(promptRequests).toBe(0);

  await swapFromMenu();
  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();
  await expect.poll(() => backgroundRequests).toBe(2);
  await page.getByRole('tab', { name: /^Second/u }).click();
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect.poll(() => foregroundRequests).toBe(2);
});
