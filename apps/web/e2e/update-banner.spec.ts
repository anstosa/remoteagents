import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, paneInputList, pushBytes, pushMetadata } from './pane-stream-mock';

// open the reviewed host update from global settings
const openUpstreamUpdate = async (page: Page) => {
  await page.getByRole('button', { name: /Global settings/u }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'View upstream update' }).click();
};

test('keeps the embedded update advisor out of the main agent tabs', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one normal agent beside one recovered update advisor
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', queuedPromptCount: 0 }, { id: 'update-advisor', sessionId: 'socket:$2', workspace: '/workspace', displayLabel: 'Update Advisor v4 3333333', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
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
  const revisionSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
  const committedAt = '2026-09-06T14:22:31-07:00';
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // report a newer browser bundle
    if (url.pathname === '/api/ui-version') return route.fulfill({ json: { version: '/assets/index-new.js' } });
    // keep the host repository current
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // publish deployed server metadata
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: revisionSha, committedAt } });
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
  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('button', { name: 'Reload local update' })).toHaveCount(0);
  await expect(tabs.getByRole('button', { name: 'View upstream update' })).toHaveCount(0);
  await page.getByRole('button', { name: /Global settings/u }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const server = settings.getByRole('group', { name: 'Server' });
  await expect(server.getByText(revisionSha.slice(0, 7))).toBeVisible();
  await expect(server.locator('time')).toHaveAttribute('datetime', committedAt);
  const reload = settings.getByRole('button', { name: 'Reload local update' });
  await expect(reload).toBeVisible();
  await reload.click();

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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
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
  await openUpstreamUpdate(page);

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
  const reopen = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Reopen server update' });
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
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // reveal the dedicated advisor after launch
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: advisorLaunched ? 2 : 1, agents: advisorLaunched ? [{ id: 'update-advisor', sessionId: 'socket:$2', workspace: '/workspace', displayLabel: `Update Advisor v4 ${targetSha.slice(0, 7)}`, title: 'Ready', queuedPromptCount: 0 }] : [], projects: [] } });
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
  await openUpstreamUpdate(page);
  const settingsPage = page.locator('#global-settings-page');
  await expect(settingsPage).toHaveAttribute('inert', '');
  await expect(settingsPage).toHaveAttribute('aria-hidden', 'true');
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Change server configuration')).toBeVisible();
  await expect(dialog.getByText('.env.example')).toBeVisible();
  const output = dialog.getByLabel('Update advisor output');
  await expect(output).toBeVisible();
  // the advisor's pane streams inside a narrow modal: let the terminal measure its own grid
  // (the mock echoes its viewport back as the size) rather than forcing a wide one that would
  // overflow, then paint the reviewed output and publish the response the feedback form gates on
  await page.waitForFunction(() => (window as unknown as { __pane: { lastViewport: (id: string) => unknown } }).__pane.lastViewport('update-advisor') !== undefined);
  // A few blank rows first so the selectable row clears the top-left status badge (the stream
  // writes top-down), then the completed response the feedback form gates on.
  await pushBytes(page, 'update-advisor', '\r\n\r\n\r\nReview complete\r\n');
  await pushMetadata(page, 'update-advisor', 'No host migration is required for this update.');
  const outputBounds = await output.evaluate(element => {
    const output = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
    return { outputRight: output.right, outputBottom: output.bottom, screenRight: screen.right, screenBottom: screen.bottom };
  });
  expect(outputBounds.screenRight).toBeLessThanOrEqual(outputBounds.outputRight + 1);
  expect(outputBounds.screenBottom).toBeLessThanOrEqual(outputBounds.outputBottom + 1);
  // double-click the reviewed word to select it (a pixel drag is unreliable in the narrow modal)
  const selectedRow = output.locator('.xterm-rows > div', { hasText: 'Review complete' });
  const selectedRowBounds = await selectedRow.boundingBox();
  expect(selectedRowBounds).not.toBeNull();
  await page.mouse.dblclick(selectedRowBounds!.x + selectedRowBounds!.width * 0.2, selectedRowBounds!.y + selectedRowBounds!.height / 2);
  const selectionToolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(output.locator('.log')).toHaveClass(/selection-active/u);
  await expect(selectionToolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Add to prompt' })).toHaveCount(0);
  await output.getByLabel('Live log').click({ position: { x: 180, y: 80 } });
  await expect(selectionToolbar).toHaveCount(0);
  await expect(output.locator('.log')).toHaveClass(/input-active/u);
  await expect(output.getByLabel('Terminal keys')).toBeVisible();
  const inputBounds = await output.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
    return { outputRight: bounds.right, outputBottom: bounds.bottom, screenRight: screen.right, screenBottom: screen.bottom };
  });
  expect(inputBounds.screenRight).toBeLessThanOrEqual(inputBounds.outputRight + 1);
  expect(inputBounds.screenBottom).toBeLessThanOrEqual(inputBounds.outputBottom + 1);
  await output.getByRole('button', { name: 'Ctrl+C' }).click();
  // the interrupt reaches the advisor's pane over its own stream, not a separate input socket
  await expect.poll(() => paneInputList(page, 'update-advisor')).toContain('\x03');
  await expect(page.getByRole('tab', { name: /Update Advisor/u })).toHaveCount(0);
  const update = dialog.getByRole('button', { name: 'Update', exact: true });
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  // Move focus out of the pane before acknowledging: a focused xterm swallows the first click
  // that lands outside it, and an operator acknowledging is not mid-keystroke in the terminal.
  await dialog.getByRole('heading', { name: 'Host changes need review' }).click();
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
  await pushMetadata(page, 'update-advisor', 'No host migration is required for this update.');
  await expect(update).toBeDisabled();
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toHaveCount(0);
  // unlock review only after a new response arrives
  await pushMetadata(page, 'update-advisor', 'Rollback steps were double-checked; no migration is required.');
  await expect(dialog.getByText('I reviewed the advisor guidance for this exact update.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close server update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settingsPage).not.toHaveAttribute('inert', '');
  await expect(settingsPage).not.toHaveAttribute('aria-hidden', 'true');
  await expect(settingsPage.getByRole('button', { name: 'View upstream update' })).toBeFocused();
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
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
  await openUpstreamUpdate(page);
  const dialog = page.getByRole('dialog', { name: 'Review update' });
  await expect(dialog.getByText('Host rebuild needs another attempt.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry rebuild' }).click();

  await expect.poll(() => retryStarts).toBe(1);
  await expect(dialog.getByText('Pulling the reviewed revision, rebuilding, and restarting…')).toBeVisible();
});
