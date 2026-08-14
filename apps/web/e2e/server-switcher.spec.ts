import { expect, test } from '@playwright/test';

test('shows and switches the configured server on authentication and output screens', async ({ page }) => {
  let screen: 'login'|'control'|'output' = 'login';
  let remoteAttention: 'question'|'completed' = 'question';
  let statusAvailable = true;
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [{ name: 'Framework', url: 'https://framework.santosa.dev', icon: 'heart' }] };
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
    // provide the mutable peer-attention fixture
    if (url.pathname === '/api/server-statuses') {
      // simulate an aggregate outage
      if (!statusAvailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      return route.fulfill({ json: { servers: [{ url: server.url, attention: 'idle' }, { url: server.remotes[0]!.url, attention: remoteAttention }] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  // verify custom server choices
  const expectSwitcher = async (remoteLabel = 'Framework') => {
    const switcher = page.getByRole('combobox', { name: 'Remote Agents server' });
    await expect(switcher).toBeVisible();
    await expect(switcher).toHaveText('X1 Carbon');
    await switcher.click();
    const choices = page.getByRole('option');
    await expect(choices).toHaveText(['X1 Carbon', 'Framework']);
    await expect(choices.nth(1)).toHaveAccessibleName(remoteLabel);
    await expect(choices.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(choices.nth(1)).toHaveAttribute('aria-selected', 'false');
    await expect(choices.nth(0).locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
    await expect(choices.nth(1).locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
    await expect(choices.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(choices.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(switcher).toHaveAttribute('aria-expanded', 'false');
    return switcher;
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible();
  await expectSwitcher();

  screen = 'control';
  await page.reload();
  await expect(page.getByText('Desk iPad is active')).toBeVisible();
  await expectSwitcher('Framework — Active question');

  screen = 'output';
  remoteAttention = 'completed';
  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  const outputSwitcher = await expectSwitcher('Framework — Completed notification');
  const bounds = await outputSwitcher.boundingBox();
  const outputBounds = await page.locator('.log-output').boundingBox();
  expect(bounds!.x).toBeLessThan(outputBounds!.x + outputBounds!.width / 2);
  expect(bounds!.y).toBeLessThan(outputBounds!.y + outputBounds!.height / 2);

  await outputSwitcher.click();
  const remoteOption = page.getByRole('option').nth(1);
  await expect(remoteOption).toHaveAccessibleName('Framework — Completed notification');
  await expect(remoteOption.locator('.server-switcher-attention')).toHaveClass(/completed/u);

  statusAvailable = false;
  await expect(remoteOption).toHaveAccessibleName('Framework — Unavailable', { timeout: 8_000 });
  await expect(remoteOption.locator('.server-switcher-attention')).toHaveClass(/unavailable/u);

  statusAvailable = true;
  remoteAttention = 'question';
  await expect(remoteOption).toHaveAccessibleName('Framework — Active question', { timeout: 8_000 });
  await expect(remoteOption.locator('.server-switcher-attention')).toHaveClass(/question/u);
  await remoteOption.click();
  await expect(page).toHaveURL('https://framework.santosa.dev/');
  await expect(page.getByRole('heading', { name: 'Framework target' })).toBeVisible();
});
