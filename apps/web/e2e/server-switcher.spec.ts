import { expect, test } from '@playwright/test';

test('shows and switches the configured server on authentication and output screens', async ({ page }) => {
  let screen: 'login'|'control'|'output' = 'login';
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', remotes: [{ name: 'Framework', url: 'https://framework.santosa.dev' }] };
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // connect the dashboard and output fixtures
      constructor(_url: string | URL) {
        window.setTimeout(() => {
          // open each pending socket once
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }
      send() {}
      // close one fixture socket
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // complete remote navigation without network access
    if (url.hostname === 'framework.santosa.dev') return route.fulfill({ contentType: 'text/html', body: '<title>Framework target</title><h1>Framework target</h1>' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/auth/session') {
      if (screen === 'login') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: screen === 'output', deviceName: 'Test device', controllingDeviceName: screen === 'control' ? 'Desk iPad' : undefined, server } });
    }
    if (url.pathname === '/api/auth/bootstrap') return route.fulfill({ json: { csrfToken: 'bootstrap-token', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  const expectSwitcher = async () => {
    const switcher = page.getByRole('combobox', { name: 'Remote Agents server' });
    await expect(switcher).toBeVisible();
    await expect(switcher.locator('option:checked')).toHaveText('X1 Carbon');
    await expect(switcher.locator('option')).toHaveText(['X1 Carbon', 'Framework']);
    return switcher;
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible();
  await expectSwitcher();

  screen = 'control';
  await page.reload();
  await expect(page.getByText('Desk iPad is active')).toBeVisible();
  await expectSwitcher();

  screen = 'output';
  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  const outputSwitcher = await expectSwitcher();
  const bounds = await outputSwitcher.boundingBox();
  const outputBounds = await page.locator('.log-output').boundingBox();
  expect(bounds!.x).toBeLessThan(outputBounds!.x + outputBounds!.width / 2);
  expect(bounds!.y).toBeLessThan(outputBounds!.y + outputBounds!.height / 2);

  await outputSwitcher.selectOption('https://framework.santosa.dev');
  await expect(page).toHaveURL('https://framework.santosa.dev/');
  await expect(page.getByRole('heading', { name: 'Framework target' })).toBeVisible();
});
