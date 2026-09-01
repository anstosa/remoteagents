import { expect, test } from '@playwright/test';

test('refits each worktree output after moving from mobile to desktop', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 428, height: 900 });
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
          const agent = /\/ws\/logs\/(agent-[12])/.exec(this.url)?.[1];
          if (agent !== undefined) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
            v: 1,
            type: 'reset',
            text: `${agent} output\n${agent} height marker`
          }) }));
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeLabel: 'Cora', title: 'Ready' },
      { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', worktreeLabel: 'Owen', title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/.test(url.pathname)) return route.fulfill({ json: { ticket: `${String((request.postDataJSON() as { kind?: unknown }).kind)}-ticket` } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  const latestViewport = async (agentId: string) => page.evaluate(id => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames
      .filter(frame => frame.url.includes(`/ws/logs/${id}`))
      .map(frame => JSON.parse(frame.data) as { type?: string; cols?: number; rows?: number })
      .filter(frame => frame.type === 'viewport')
      .at(-1);
  }, agentId);
  const markerBottomGap = async (agentId: string) => page.evaluate(id => {
    const screen = document.querySelector<HTMLElement>('.terminal-frame.active .xterm-screen');
    const row = [...document.querySelectorAll<HTMLElement>('.terminal-frame.active .xterm-rows > div')]
      .find(candidate => candidate.textContent?.includes(`${id} height marker`));
    if (screen === null || row === undefined) return undefined;
    return screen.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom;
  }, agentId);

  await page.goto('/');
  await expect.poll(() => latestViewport('agent-1'), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => markerBottomGap('agent-1'), { timeout: 15_000 }).toBeLessThan(20);
  const coraMobile = (await latestViewport('agent-1'))!;

  await page.getByRole('tab', { name: /^Owen/ }).click();
  await expect.poll(() => latestViewport('agent-2'), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => markerBottomGap('agent-2'), { timeout: 15_000 }).toBeLessThan(20);
  const owenMobile = (await latestViewport('agent-2'))!;

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(async () => (await latestViewport('agent-2'))?.cols ?? 0, { timeout: 15_000 }).toBeGreaterThan(owenMobile.cols!);

  await page.getByRole('tab', { name: /^Cora/ }).click();
  await expect.poll(async () => (await latestViewport('agent-1'))?.cols ?? 0, { timeout: 15_000 }).toBeGreaterThan(coraMobile.cols!);
  const coraDesktop = (await latestViewport('agent-1'))!;
  expect(coraDesktop.rows).toBeGreaterThan(coraMobile.rows!);
  await expect.poll(() => markerBottomGap('agent-1'), { timeout: 15_000 }).toBeLessThan(20);
});
