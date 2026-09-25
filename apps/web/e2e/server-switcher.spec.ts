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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
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
    const targets = group.locator('.server-switcher-button:not(.server-switcher-settings)');
    await expect(group).toBeVisible();
    await expect(targets).toHaveText(['X1 Carbon', remoteServer.name]);
    // require the current server on the left
    await expect(targets.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(1)).not.toHaveAttribute('aria-current', 'page');
    await expect(targets.nth(0).locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
    await expect(targets.nth(1).locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
    // preserve Android WebAPK link capture
    await expect(group.locator('button.server-switcher-button:not(.server-switcher-settings)')).toHaveCount(1);
    await expect(group.locator('a.server-switcher-button')).toHaveAttribute('href', remoteServer.url);
    // verify an attention label when requested
    if (remoteLabel !== undefined) await expect(targets.nth(1)).toHaveAccessibleName(remoteLabel);
    return { group, current: targets.nth(0), remote: targets.nth(1) };
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible();
  await expectServerTargets();
  await expect(page.getByRole('combobox', { name: /Remote Agents server/u })).toHaveCount(0);

  remoteServer.name = 'Framework Workstation';
  remoteName = remoteServer.name;
  screen = 'control';
  await page.reload();
  await expect(page.getByText('Desk iPad is active')).toBeVisible();
  const controlServers = await expectServerTargets(`${remoteName} — Working`);
  // settings need a ready console session, so the takeover screen offers servers only
  await expect(controlServers.group.getByRole('button', { name: 'Global settings' })).toHaveCount(0);
  // preserve takeover-screen status markers
  const controlStatusDots = controlServers.group.locator('.server-switcher-attention.working');
  await expect(controlStatusDots).toHaveCount(2);
  await expect(controlStatusDots.first()).toBeVisible();
  await expect(controlStatusDots.last()).toBeVisible();
  await expect(controlStatusDots.first()).toHaveCSS('opacity', '1');
  await expect(controlStatusDots.last()).toHaveCSS('opacity', '1');
  await expect(controlStatusDots.first()).toHaveCSS('position', 'absolute');
  // pin the compact status badge to the server tab corner
  const [controlServerBounds, controlDotBounds] = await Promise.all([renderedBounds(controlServers.current), renderedBounds(controlStatusDots.first())]);
  expect(Math.abs(controlDotBounds.x + controlDotBounds.width - (controlServerBounds.x + controlServerBounds.width - 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(controlDotBounds.y - (controlServerBounds.y + 4))).toBeLessThanOrEqual(1);
  expect(controlDotBounds.width).toBeLessThan(8);
  // require the takeover card to expand with complete labels
  const [controlCardBounds, controlGroupBounds] = await Promise.all([renderedBounds(page.locator('.console-recovery')), renderedBounds(controlServers.group)]);
  expect(controlCardBounds.width).toBeGreaterThan(320);
  expect(controlCardBounds.width).toBeGreaterThan(controlGroupBounds.width);
  // keep the expanded card within a narrow viewport
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowControlCardBounds = await renderedBounds(page.locator('.console-recovery'));
  expect(narrowControlCardBounds.x).toBeGreaterThanOrEqual(0);
  expect(narrowControlCardBounds.x + narrowControlCardBounds.width).toBeLessThanOrEqual(390);
  const narrowControlLabelsFit = await controlServers.group.locator('.server-switcher-button > span').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth));
  expect(narrowControlLabelsFit).toBe(true);
  const narrowControlScrolls = await controlServers.group.evaluate(group => group.scrollWidth > group.clientWidth);
  // keep the corner badges out of the horizontal layout
  expect(narrowControlScrolls).toBe(false);

  remoteServer.name = 'Framework';
  remoteName = remoteServer.name;
  screen = 'output';
  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  // nothing floats over the output: the selector leads the tab row instead
  await expect(page.locator('.log-output .server-switcher, .output-server-switcher')).toHaveCount(0);
  const tabRow = page.locator('.tabs');
  const lead = tabRow.locator('> .tab-row-lead');
  await expect(tabRow.locator('> :first-child')).toHaveClass(/tab-row-lead/u);
  const selector = lead.getByRole('button', { name: /^Switch server \(X1 Carbon\)/u });
  await expect(lead.locator('> :first-child')).toHaveAccessibleName(/^Switch server/u);
  await expect(lead.locator('> :last-child').getByRole('button', { name: 'Global settings' })).toBeVisible();
  await expect(selector.locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
  await expect(selector.locator('.server-selector-name')).toHaveText('X1 Carbon');
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  // the selector rolls up the other servers' attention
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Working on another server');
  await expect(selector.locator('.server-switcher-attention')).toHaveClass(/working/u);
  const activeTab = page.getByRole('tab', { selected: true });
  const [selectorBounds, tabBounds, outputBounds] = await Promise.all([renderedBounds(selector), renderedBounds(activeTab), renderedBounds(page.locator('.log-output'))]);
  expect(selectorBounds.x).toBeLessThan(tabBounds.x);
  expect(Math.abs(selectorBounds.y - tabBounds.y)).toBeLessThanOrEqual(1);
  expect(selectorBounds.y).toBeGreaterThanOrEqual(outputBounds.y + outputBounds.height - 1);

  // the menu lists the servers with their attention, and nothing else
  await selector.click();
  await expect(selector).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Remote Agents servers' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('a, button')).toHaveCount(2);
  const current = menu.locator('button.server-menu-item');
  const remote = menu.locator('a.server-menu-item');
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toHaveAccessibleName('X1 Carbon — Working');
  await expect(current.locator('img')).toHaveAttribute('src', '/instance-icons/potato.svg');
  // preserve Android WebAPK link capture
  await expect(remote).toHaveAttribute('href', remoteServer.url);
  await expect(remote).toHaveAccessibleName('Framework — Working');
  await expect(remote.locator('img')).toHaveAttribute('src', '/instance-icons/heart.svg');
  await expect(menu.locator('.server-switcher-attention.working')).toHaveCount(2);
  // choosing the current server just closes the menu
  await current.click();
  await expect(menu).toHaveCount(0);
  await expect(selector).toHaveAttribute('aria-expanded', 'false');

  remoteName = 'Framework Published';
  remoteAttention = 'completed';
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Completed notification on another server', { timeout: 8_000 });
  await selector.click();
  await expect(remote).toHaveAccessibleName('Framework Published — Completed notification');
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/completed/u);

  statusAvailable = false;
  await expect(remote).toHaveAccessibleName('Framework Published — Server unavailable', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/unavailable/u);
  // an unreachable server is not attention, so the selector stays bare
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon)');
  await expect(selector.locator('.server-switcher-attention')).toHaveCount(0);

  statusAvailable = true;
  remoteAttention = 'question';
  await expect(remote).toHaveAccessibleName('Framework Published — Active question', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/question/u);
  await expect(selector.locator('.server-switcher-attention')).toHaveClass(/question/u);
  // show a neutral marker when the server needs no attention
  remoteAttention = 'idle';
  await expect(remote).toHaveAccessibleName('Framework Published — Idle', { timeout: 8_000 });
  await expect(remote.locator('.server-switcher-attention')).toHaveClass(/idle/u);
  await expect(remote.locator('.server-switcher-attention')).toHaveCSS('background-color', 'rgb(88, 91, 112)');
  // an idle peer adds no marker to the selector
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon)');
  await expect(selector.locator('.server-switcher-attention')).toHaveCount(0);

  // the phone keeps the logo and chevron but drops the name
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selector.locator('.server-selector-name')).toBeHidden();
  await expect(selector.locator('img')).toBeVisible();
  const [narrowSelectorBounds, titleBounds, narrowOutputBounds] = await Promise.all([renderedBounds(selector), renderedBounds(page.locator('.agent-panel .panel-header-title')), renderedBounds(page.locator('.log-output'))]);
  expect(narrowSelectorBounds.x).toBeLessThanOrEqual(1);
  // the agent panel's title pill takes the corner the switcher left
  expect(titleBounds.y - narrowOutputBounds.y).toBeLessThan(12);

  await selector.click();
  await remote.click();
  await expect(page).toHaveURL('https://framework.santosa.dev/');
  await expect(page.getByRole('heading', { name: 'Framework target' })).toBeVisible();
});

test('leads the empty console tab row with the server selector', async ({ page }) => {
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes: [] };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  const lead = page.locator('.tabs > .tab-row-lead');
  await expect(lead.getByRole('button', { name: 'Switch server (X1 Carbon)' })).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Global settings' })).toBeVisible();
  await lead.getByRole('button', { name: 'Switch server (X1 Carbon)' }).click();
  const menu = page.getByRole('group', { name: 'Remote Agents servers' });
  await expect(menu.locator('a, button')).toHaveCount(1);
  await expect(menu.locator('button.server-menu-item')).toHaveAttribute('aria-current', 'page');
});

test('rolls the most urgent remote attention onto the closed selector', async ({ page }) => {
  const remotes = [{ name: 'Framework', url: 'https://framework.santosa.dev', icon: 'heart' }, { name: 'Homelab', url: 'https://homelab.santosa.dev', icon: 'terminal' }];
  const server = { name: 'X1 Carbon', url: 'https://x1carbon.santosa.dev', icon: 'potato', remotes };
  let attention = { framework: 'working', homelab: 'question' };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/server-statuses') return route.fulfill({ json: { servers: [{ name: server.name, url: server.url, icon: server.icon, attention: 'idle' }, { ...remotes[0], attention: attention.framework }, { ...remotes[1], attention: attention.homelab }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const selector = page.locator('.tab-row-lead .server-selector');
  // a question on one remote outranks work on another
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Active question on another server');
  await expect(selector.locator('.server-switcher-attention')).toHaveClass(/question/u);
  // an unread result outranks work, whichever remote carries it
  attention = { framework: 'completed', homelab: 'working' };
  await expect(selector).toHaveAccessibleName('Switch server (X1 Carbon) — Completed notification on another server', { timeout: 8_000 });
  await expect(selector.locator('.server-switcher-attention')).toHaveClass(/completed/u);
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
