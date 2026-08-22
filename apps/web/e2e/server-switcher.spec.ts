import { expect, test, type Locator } from '@playwright/test';

type BoundingBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

// require rendered locator bounds
const renderedBounds = async (locator: Locator): Promise<BoundingBox> => {
  const bounds = await locator.boundingBox();
  // fail clearly when the element is not rendered
  if (bounds === null) throw new Error('Expected locator to have rendered bounds');
  return bounds;
};

test('shows and switches the configured server on authentication and output screens', async ({ page }) => {
  let screen: 'login'|'control'|'output' = 'login';
  let remoteAttention: 'idle'|'working'|'question'|'completed' = 'working';
  let remoteName = 'Framework';
  let statusAvailable = true;
  const remoteServer = { name: 'Framework', url: 'https://framework.santosa.dev', icon: 'heart' };
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [remoteServer] };
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
      return route.fulfill({ json: { servers: [{ name: server.name, url: server.url, icon: server.icon, attention: 'working' }, { ...remoteServer, name: remoteName, attention: remoteAttention }] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  // verify direct server targets
  const expectServerTargets = async (remoteLabel?: string) => {
    const group = page.getByRole('group', { name: 'Remote Agents servers' });
    const targets = group.locator('.server-switcher-button:not(.server-switcher-voice):not(.server-switcher-settings)');
    await expect(group).toBeVisible();
    await expect(targets).toHaveText(['X1 Carbon', 'Framework']);
    // require the current server on the left
    await expect(targets.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(1)).not.toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(0).locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
    await expect(targets.nth(1).locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
    // preserve Android WebAPK link capture
    await expect(group.locator('button.server-switcher-button:not(.server-switcher-voice):not(.server-switcher-settings)')).toHaveCount(1);
    await expect(group.locator('a.server-switcher-button')).toHaveAttribute('href', remoteServer.url);
    // verify an attention label when requested
    if (remoteLabel !== undefined) await expect(targets.nth(1)).toHaveAccessibleName(remoteLabel);
    return { group, current: targets.nth(0), remote: targets.nth(1) };
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible();
  await expectServerTargets();
  await expect(page.getByRole('combobox', { name: /Remote Agents server/u })).toHaveCount(0);

  screen = 'control';
  await page.reload();
  await expect(page.getByText('Desk iPad is active')).toBeVisible();
  await expectServerTargets('Framework — Working');

  screen = 'output';
  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  const outputServers = await expectServerTargets('Framework — Working');
  await expect(outputServers.group).toHaveClass(/output-server-switcher/u);
  await expect(page.locator('.log-output .server-switcher')).toHaveCount(1);
  await expect(outputServers.group.locator('.server-switcher-attention.working')).toHaveCount(2);
  const activeTab = page.getByRole('tab', { selected: true });
  const [currentBounds, remoteBounds, outputBounds] = await Promise.all([renderedBounds(outputServers.current), renderedBounds(outputServers.remote), renderedBounds(page.locator('.log-output'))]);
  expect(currentBounds.x).toBeLessThan(remoteBounds.x);
  expect(currentBounds.x).toBeLessThan(outputBounds.x + outputBounds.width / 2);
  expect(currentBounds.y).toBeLessThan(outputBounds.y + outputBounds.height / 2);
  const [currentBorderEffect, tabBorderEffect] = await Promise.all([
    outputServers.current.evaluate(element => getComputedStyle(element).boxShadow),
    activeTab.evaluate(element => getComputedStyle(element).boxShadow)
  ]);
  expect(currentBorderEffect).toBe(tabBorderEffect);
  // keep status below controls on narrow screens
  await page.setViewportSize({ width: 390, height: 844 });
  const [serverRowBounds, statusBounds] = await Promise.all([renderedBounds(outputServers.group), renderedBounds(page.locator('.log-status'))]);
  expect(serverRowBounds.y + serverRowBounds.height).toBeLessThanOrEqual(statusBounds.y);

  remoteName = 'Framework Published';
  remoteAttention = 'completed';
  await expect(outputServers.remote).toHaveAccessibleName('Framework Published — Completed notification', { timeout: 8_000 });
  await expect(outputServers.remote.locator('.server-switcher-attention')).toHaveClass(/completed/u);

  statusAvailable = false;
  await expect(outputServers.remote).toHaveAccessibleName('Framework Published — Server unavailable', { timeout: 8_000 });
  await expect(outputServers.remote.locator('.server-switcher-attention')).toHaveClass(/unavailable/u);

  statusAvailable = true;
  remoteAttention = 'question';
  await expect(outputServers.remote).toHaveAccessibleName('Framework Published — Active question', { timeout: 8_000 });
  await expect(outputServers.remote.locator('.server-switcher-attention')).toHaveClass(/question/u);
  // show a neutral marker when the server needs no attention
  remoteAttention = 'idle';
  await expect(outputServers.remote).toHaveAccessibleName('Framework Published — Idle', { timeout: 8_000 });
  await expect(outputServers.remote.locator('.server-switcher-attention')).toHaveClass(/idle/u);
  await expect(outputServers.remote.locator('.server-switcher-attention')).toHaveCSS('background-color', 'rgb(88, 91, 112)');
  await outputServers.remote.click();
  await expect(page).toHaveURL('https://framework.santosa.dev/');
  await expect(page.getByRole('heading', { name: 'Framework target' })).toBeVisible();
});

test('renders a single configured server as the current button', async ({ page }) => {
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // serve the public login metadata
    if (url.pathname === '/api/auth/session') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    if (url.pathname === '/api/auth/bootstrap') return route.fulfill({ json: { csrfToken: 'bootstrap-token', server } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    return route.continue();
  });

  await page.goto('/');
  const group = page.getByRole('group', { name: 'Remote Agents servers' });
  const buttons = group.getByRole('button');
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveText(['X1 Carbon']);
  await expect(buttons.first()).toHaveAttribute('aria-current', 'page');
});
