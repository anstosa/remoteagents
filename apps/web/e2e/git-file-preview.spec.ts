import { expect, test } from '@playwright/test';

test('previews a changed file while new agent output arrives', async ({ page }) => {
  await page.addInitScript(() => {
    let logSocket: MockWebSocket | undefined;
    // model the dashboard log connection
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
      constructor(url: string | URL) {
        this.url = String(url);
        // retain the agent log connection
        if (this.url.includes('/ws/logs/')) logSocket = this;
        window.setTimeout(() => {
          // ignore closed connections
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          // seed one completed response
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\n', latestAssistantMessage: 'Initial response' }) }));
        });
      }
      // ignore client messages
      send() {}
      // close the mock connection
      close() {
        // preserve idempotent closes
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    // emit a later assistant response
    Object.defineProperty(window, 'emitAgentResponse', { configurable: true, value: () => logSocket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'append', text: 'Still working\n', latestAssistantMessage: 'Updated response' }) })) });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // return the authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // return one changed active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/file-preview', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'apps/server/src/app.ts', additions: 12, deletions: 3 }] }, title: 'Ready' }], projects: [] } });
    // return log authorization
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty auxiliary data
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // return the selected changed file
    if (url.pathname === '/api/agents/agent-1/file-preview') {
      expect(request.postDataJSON()).toEqual({ path: 'apps/server/src/app.ts' });
      return route.fulfill({ json: { path: 'apps/server/src/app.ts', size: 25, binary: false, truncated: false, content: 'export const app = true;\n' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'Preview apps/server/src/app.ts' }).click();
  const preview = page.getByRole('dialog', { name: 'File preview: apps/server/src/app.ts' });
  await expect(preview.getByLabel('Contents of apps/server/src/app.ts')).toContainText('export const app = true;');

  // update the response-file lifecycle
  await page.evaluate(() => (window as typeof window & { emitAgentResponse: () => void }).emitAgentResponse());
  await expect(preview).toBeVisible();
});
