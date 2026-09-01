import { expect, test } from '@playwright/test';

test('places the update chip in the tab bar beside notification controls', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs" role="tablist" style="width: 800px">
      <button role="tab">Agent</button>
      <button class="notification-control" type="button">Enable alerts</button>
      <button class="update-ready" type="button">Upstream update <span>View</span></button>
      <span class="launcher"><button class="new-agent-tab" type="button">+</button></span>
    </nav>
    <section class="panel" style="width: 800px; height: 500px"></section>
  `);

  const tabs = page.getByRole('tablist');
  const notification = page.getByRole('button', { name: 'Enable alerts' });
  const banner = page.getByRole('button', { name: 'Upstream update View' });
  await expect(tabs.locator(':scope > .update-ready')).toHaveCount(1);
  await expect(page.locator('.panel .update-ready')).toHaveCount(0);
  const [notificationBounds, bannerBounds] = await Promise.all([notification.boundingBox(), banner.boundingBox()]);
  expect(notificationBounds).not.toBeNull();
  expect(bannerBounds).not.toBeNull();
  expect(Math.abs(notificationBounds!.y + notificationBounds!.height / 2 - (bannerBounds!.y + bannerBounds!.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(notificationBounds!.height - bannerBounds!.height)).toBeLessThanOrEqual(1);
});

test('keeps the embedded update advisor out of the main agent tabs', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one normal agent beside one recovered update advisor
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', queuedPromptCount: 0 }, { id: 'update-advisor', sessionId: 'socket:$2', workspace: '/workspace', displayLabel: 'Update Advisor v4 3333333', title: 'Ready', queuedPromptCount: 0 }], worktrees: [] } });
    // keep the host repository current
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // authorize the visible agent output
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty visible-agent stores
    if (/^\/api\/agents\/agent-cora\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Cora/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Update Advisor/u })).toHaveCount(0);
});

// reload stale browser assets without launching a host update
test('reloads a stale client instead of restarting the server', async ({ page }) => {
  let updateStarts = 0;
  let navigations = 0;
  // count full-page reloads
  page.on('framenavigated', frame => {
    // ignore child-frame navigation
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render the empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], worktrees: [] } });
    // report a newer browser bundle
    if (url.pathname === '/api/ui-version') return route.fulfill({ json: { version: '/assets/index-new.js' } });
    // keep the host repository current
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // flag accidental host mutations
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const initialNavigations = navigations;
  const banner = page.getByRole('button', { name: 'Local update Reload' });
  await expect(banner).toBeVisible();
  await banner.click();

  await expect.poll(() => navigations).toBeGreaterThan(initialNavigations);
  expect(updateStarts).toBe(0);
});

// review commits before explicitly starting a host update
test('opens the commit review before starting and retains update failures in the modal', async ({ page }) => {
  let updateStarts = 0;
  let updateStatusChecks = 0;
  let updateState: 'running'|'failed' = 'running';
  let advisorLaunches = 0;
  const targetSha = '2'.repeat(40);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render one stable agent tab
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // preview one exact fast-forward update
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Add safer update review', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } });
    // reject unexpected advisor launches
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunches += 1;
      return route.fulfill({ status: 500, json: { error: 'unexpected advisor launch' } });
    }
    // start one host update
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarts += 1;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // follow one host update while hidden
    if (url.pathname === '/api/server/update/server_update_operation_1234') {
      updateStatusChecks += 1;
      return route.fulfill({ json: { id: 'server_update_operation_1234', kind: 'update', state: updateState } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect the visible agent output
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt stores
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const banner = page.getByRole('button', { name: 'Upstream update View' });
  await expect(banner).toBeVisible();
  await banner.click();

  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Add safer update review')).toBeVisible();
  expect(advisorLaunches).toBe(0);
  expect(updateStarts).toBe(0);
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(update).toBeEnabled();
  await update.click();
  await expect.poll(() => updateStarts).toBe(1);
  await expect(dialog.getByText('Pulling the reviewed revision, rebuilding, and restarting…')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close server update' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Minimize server update' }).click();
  await expect(dialog).toBeHidden();
  const visibleStatusChecks = updateStatusChecks;
  await expect.poll(() => updateStatusChecks).toBeGreaterThan(visibleStatusChecks);
  const reopen = page.getByRole('button', { name: 'Server update Reopen' });
  await expect(reopen).toBeFocused();
  await reopen.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Close server update' })).toBeDisabled();
  expect(updateStarts).toBe(1);
  updateState = 'failed';
  await expect(dialog.getByRole('status').filter({ hasText: 'Update failed. Check the server update log.' })).toBeVisible();
});

// embed migration advice and require explicit acknowledgement
test('opens an advisor for flagged update paths before enabling Update', async ({ page }) => {
  const targetSha = '3'.repeat(40);
  let advisorLaunched = false;
  let advisorStops = 0;
  await page.setViewportSize({ width: 430, height: 932 });
  await page.addInitScript(() => {
    const advisorSockets: MockWebSocket[] = [];
    const advisorSocketFrames: { url: string; data: string }[] = [];
    // publish one complete advisor metadata frame
    const emitAdvisorMetadata = (message: string) => {
      // update every connected advisor log
      for (const socket of advisorSockets) socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text: 'Review complete\n', metadata: { state: 'complete', latestAgentMessage: 'Review complete.', latestAssistantMessage: message, latestAssistantMessageOverflows: false } }) }));
    };
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
        // retain advisor log transports for response races
        if (this.url.includes('/ws/logs/update-advisor')) advisorSockets.push(this);
        window.setTimeout(() => {
          // ignore sockets closed before startup
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          // publish one completed advisor response
          if (this.url.includes('/ws/logs/update-advisor')) emitAdvisorMetadata('No host migration is required for this update.');
        });
      }
      send(data: string) {
        advisorSocketFrames.push({ url: this.url, data });
      }
      close() {
        // close one mock transport
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__emitAdvisorMetadata', { configurable: true, value: emitAdvisorMetadata });
    Object.defineProperty(window, '__advisorSocketFrames', { configurable: true, value: advisorSocketFrames });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // reveal the dedicated advisor after launch
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: advisorLaunched ? 2 : 1, agents: advisorLaunched ? [{ id: 'update-advisor', sessionId: 'socket:$2', workspace: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: 'Ready', queuedPromptCount: 0 }] : [], worktrees: [] } });
    // report remote commits on main
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // preview one flagged configuration change
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Change server configuration', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } } });
    // launch one pre-prompted advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'POST') {
      advisorLaunched = true;
      return route.fulfill({ status: 201, json: { agentId: 'update-advisor', targetSha } });
    }
    // stop the modal-owned advisor
    if (url.pathname === '/api/server/update-advisor' && request.method() === 'DELETE') {
      advisorStops += 1;
      advisorLaunched = false;
      return route.fulfill({ status: 204 });
    }
    // authorize advisor output
    if (url.pathname === '/api/agents/update-advisor/tickets') return route.fulfill({ json: { ticket: 'advisor-ticket' } });
    // accept one advisor follow-up
    if (url.pathname === '/api/agents/update-advisor/prompt' && request.method() === 'POST') return route.fulfill({ status: 202, json: { status: 'queued' } });
    // return empty prompt stores for the background agent tab
    if (/^\/api\/agents\/update-advisor\/(?:saved-prompts|prompt-history|queued-prompts|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Upstream update View' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Change server configuration')).toBeVisible();
  await expect(dialog.getByText('.env.example')).toBeVisible();
  const output = dialog.getByLabel('Update advisor output');
  await expect(output).toBeVisible();
  const outputBounds = await output.evaluate(element => {
    const output = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
    return { outputRight: output.right, outputBottom: output.bottom, screenRight: screen.right, screenBottom: screen.bottom };
  });
  expect(outputBounds.screenRight).toBeLessThanOrEqual(outputBounds.outputRight + 1);
  expect(outputBounds.screenBottom).toBeLessThanOrEqual(outputBounds.outputBottom + 1);
  const screen = output.locator('.terminal-frame.active .xterm-screen');
  const selectedRow = output.locator('.terminal-frame.active .xterm-rows > div', { hasText: 'Review complete' });
  const [screenBounds, selectedRowBounds, cell] = await Promise.all([
    screen.boundingBox(),
    selectedRow.boundingBox(),
    output.locator('.terminal-frame.active .xterm-char-measure-element').first().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width / (element.textContent?.length ?? 1), height: bounds.height };
    })
  ]);
  expect(screenBounds).not.toBeNull();
  expect(selectedRowBounds).not.toBeNull();
  const selectionY = selectedRowBounds!.y + cell.height / 2;
  await page.mouse.move(screenBounds!.x + cell.width, selectionY);
  await page.mouse.down();
  await page.mouse.move(screenBounds!.x + cell.width * 7, selectionY, { steps: 4 });
  await page.mouse.up();
  const selectionToolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(output.locator('.log')).toHaveClass(/selection-active/u);
  await expect(selectionToolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Add to prompt' })).toHaveCount(0);
  await output.getByLabel('Live log').click({ position: { x: 180, y: 80 } });
  await expect(selectionToolbar).toHaveCount(0);
  await expect(output.getByRole('button', { name: 'Page up' })).toBeVisible();
  await expect(output.getByRole('button', { name: 'Page down' })).toBeVisible();
  await output.getByRole('button', { name: 'Page up' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __advisorSocketFrames: { url: string; data: string }[] }).__advisorSocketFrames.some(frame => frame.url.includes('/ws/logs/update-advisor') && JSON.parse(frame.data).type === 'history' && JSON.parse(frame.data).offset > 0))).toBe(true);
  await output.getByLabel('Live log').click({ position: { x: 180, y: 80 } });
  await expect(output.locator('.log')).toHaveClass(/input-active/u);
  await expect(output.getByLabel('Terminal keys')).toBeVisible();
  const inputBounds = await output.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.terminal-frame.active .xterm-screen')!.getBoundingClientRect();
    const status = element.querySelector<HTMLElement>('.log-status')!.getBoundingClientRect();
    return { outputRight: bounds.right, outputBottom: bounds.bottom, screenTop: screen.top, screenRight: screen.right, screenBottom: screen.bottom, statusBottom: status.bottom };
  });
  expect(inputBounds.screenRight).toBeLessThanOrEqual(inputBounds.outputRight + 1);
  expect(inputBounds.screenBottom).toBeLessThanOrEqual(inputBounds.outputBottom + 1);
  expect(inputBounds.screenTop).toBeGreaterThanOrEqual(inputBounds.statusBottom);
  await output.getByRole('button', { name: 'Ctrl+C' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __advisorSocketFrames: { url: string; data: string }[] }).__advisorSocketFrames.some(frame => frame.url.includes('/ws/input/update-advisor') && JSON.parse(frame.data).type === 'input'))).toBe(true);
  await expect(page.getByRole('tab', { name: /Update Advisor/u })).toHaveCount(0);
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await expect(update).toBeEnabled();
  await dialog.getByLabel('Approval or feedback').fill('Double-check the rollback steps.');
  await expect(output.locator('.log')).not.toHaveClass(/input-active/u);
  await expect(output.getByLabel('Terminal keys')).toBeHidden();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  await expect(dialog.getByLabel('Approval or feedback')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  // ignore the prior response when a stale frame is replayed
  await page.evaluate(() => (window as typeof window & { __emitAdvisorMetadata: (message: string) => void }).__emitAdvisorMetadata('No host migration is required for this update.'));
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  // unlock review only after a new response arrives
  await page.evaluate(() => (window as typeof window & { __emitAdvisorMetadata: (message: string) => void }).__emitAdvisorMetadata('Rollback steps were double-checked; no migration is required.'));
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close server update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => advisorStops).toBe(1);
});

// retry a failed host rebuild after Git already reached the reviewed target
test('reopens a durable rebuild retry after a post-merge failure', async ({ page }) => {
  const targetSha = '4'.repeat(40);
  let retryStarts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render the empty console
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], worktrees: [] } });
    // preserve the update chip for one failed rebuild
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: true } });
    // expose the durable current-target retry
    if (url.pathname === '/api/server/update-preview') return route.fulfill({ json: { available: false, rebuildRetryAvailable: true, baseSha: targetSha, targetSha, fastForwardable: true, commitCount: 0, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } } });
    // accept one pinned rebuild retry
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      retryStarts += 1;
      expect(request.postDataJSON()).toMatchObject({ expectedTargetSha: targetSha });
      return route.fulfill({ status: 202, json: { id: 'server_update_retry_1234', kind: 'update', state: 'queued', targetSha } });
    }
    // keep the retry operation running
    if (url.pathname === '/api/server/update/server_update_retry_1234') return route.fulfill({ json: { id: 'server_update_retry_1234', kind: 'update', state: 'running', targetSha } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Upstream update View' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Host rebuild needs another attempt.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry rebuild' }).click();

  await expect.poll(() => retryStarts).toBe(1);
  await expect(dialog.getByText('Pulling the reviewed revision, rebuilding, and restarting…')).toBeVisible();
});
