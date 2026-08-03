import { expect, test } from '@playwright/test';

test('opens review in a background terminal and forwards review navigation keys', async ({ page }) => {
  let reviewRequests = 0;
  let closeReviewRequests = 0;
  let foregroundRequests = 0;

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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working' },
      { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', worktreeLabel: 'Owen', title: '⠋ Working' }
    ], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/review') {
      reviewRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/review/close') {
      closeReviewRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/foreground') {
      foregroundRequests += 1;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/agents\/agent-[12]\/tickets$/.test(url.pathname)) return route.fulfill({ json: { ticket: `${String((request.postDataJSON() as { kind?: unknown }).kind)}-ticket` } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  const review = page.locator('.more-menu').getByRole('button', { name: 'Review', exact: true });
  await expect(review.locator('.more-menu-icon')).toHaveCount(1);
  await review.click();

  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();
  await expect.poll(() => reviewRequests).toBe(1);
  const closeReview = page.getByRole('button', { name: 'Close review' });
  await expect(closeReview).toBeVisible();
  await expect(page.locator('.prompt-actions > .cancel-agent + .swap-agent')).toBeVisible();
  const reviewNavigation = page.getByRole('group', { name: 'Review navigation' });
  await expect(reviewNavigation).toBeVisible();
  await expect(page.getByRole('button', { name: 'Page up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Page down' })).toBeVisible();
  await expect(reviewNavigation.getByRole('button', { name: 'Back' })).toHaveCSS('justify-content', 'center');
  await expect(reviewNavigation.getByRole('button', { name: 'Back' })).toHaveCSS('text-align', 'center');

  await page.getByRole('tab', { name: /^Owen/ }).click();
  await expect(page.getByRole('tab', { name: /^Owen/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => closeReviewRequests).toBe(0);
  await page.getByRole('tab', { name: /^Cora/ }).click();
  await expect(page.getByRole('tab', { name: /^Cora/ })).toHaveAttribute('aria-selected', 'true');
  await expect(reviewNavigation).toBeVisible();
  expect(reviewRequests).toBe(1);
  expect(closeReviewRequests).toBe(0);

  const inputValues = async () => page.evaluate(() => {
    const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
    return frames
      .filter(frame => frame.url.includes('/ws/input/'))
      .map(frame => JSON.parse(frame.data) as { data: string })
      .map(frame => frame.data);
  });
  await reviewNavigation.getByRole('button', { name: 'Next', exact: true }).click();
  await reviewNavigation.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(async () => (await inputValues()).length).toBe(2);
  const values = (await inputValues()).map(value => Buffer.from(value, 'base64url').toString('utf8'));
  expect(values).toEqual(['\t', '\x1b[Z']);

  await closeReview.click();
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Review navigation' })).toHaveCount(0);
  await expect.poll(() => closeReviewRequests).toBe(1);
  expect(foregroundRequests).toBe(0);
});
