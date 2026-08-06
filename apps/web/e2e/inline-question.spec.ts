import { expect, test } from '@playwright/test';

test('captures OMX inline checkbox choices as a numbered agent question', async ({ page }) => {
  const output = [
    'Deployment',
    'Question 1 of 2',
    'Where should OMX deploy',
    '› [x] 1. Staging (Recommended) — Uses the isolated staging stack.',
    '  [ ] 2. Production — Deploys to the live environment.',
    '  [ ] 3. Cancel',
    '↑↓ move · Enter select',
    ''
  ].join('\n');
  let selectedIndex: number | undefined;
  await page.addInitScript(questionOutput => {
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
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: questionOutput }) }));
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
  }, output);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Action required' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      selectedIndex = (request.postDataJSON() as { index: number }).index;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Agent question')).toBeVisible();
  await expect(page.locator('.question-copy')).toContainText('Where should OMX deploy');
  const choices = page.locator('.question-choice');
  await expect(choices).toHaveCount(3);
  await expect(choices).toHaveText([
    '1Staging (Recommended) — Uses the isolated staging stack.',
    '2Production — Deploys to the live environment.',
    '3Cancel'
  ]);
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
});
