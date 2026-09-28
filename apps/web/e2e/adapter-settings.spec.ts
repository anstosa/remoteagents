import { expect, test } from '@playwright/test';

// stub a controlled console whose dashboard carries the given adapter capabilities
async function openSettings(page: import('@playwright/test').Page, adapters: unknown, options: { defaultAgent?: string; davo?: { enabled: boolean; available: boolean; name: string; context: string }; onDefaultAgent?: (kind: string) => void; onDavo?: (settings: { enabled: boolean; name: string; context: string }) => void; agentUpdates?: Array<{ kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string }>; onAgentUpdate?: (kind: string) => { kind: string; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string }; open?: boolean } = {}) {
  const davo = options.davo ?? { enabled: false, available: true, name: 'Davo', context: 'Existing Davo persona.' };
  let agentUpdates = options.agentUpdates ?? [];
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
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'adapter-csrf', active: true, deviceName: 'Test device', ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }), davo, server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // persist one selected default agent
    if (url.pathname === '/api/server/default-agent' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { kind: string };
      options.onDefaultAgent?.(payload.kind);
      return route.fulfill({ json: { defaultAgent: payload.kind } });
    }
    // publish and mutate agent versions
    if (url.pathname === '/api/agents/updates' && route.request().method() === 'GET') return route.fulfill({ json: { agents: agentUpdates } });
    const agentUpdate = /^\/api\/agents\/([^/]+)\/update$/u.exec(url.pathname);
    // execute one mocked update
    if (agentUpdate !== null && route.request().method() === 'POST') {
      const kind = decodeURIComponent(agentUpdate[1]!);
      const updated = options.onAgentUpdate?.(kind) ?? { kind, currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false };
      agentUpdates = [...agentUpdates.filter(status => status.kind !== kind), updated];
      return route.fulfill({ json: { agent: updated } });
    }
    // persist one voice settings update
    if (url.pathname === '/api/server/davo' && route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { enabled: boolean; name: string; context: string };
      options.onDavo?.(payload);
      return route.fulfill({ json: { davo: { ...payload, available: davo.available } } });
    }
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, scratchLaunch: { kind: 'codex', origin: 'default' }, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/commands') return route.fulfill({ json: { commands: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: 'a1b2c3d4e5f6789012345678901234567890abcd', committedAt: '2026-09-06T14:22:31-07:00' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/codex/accounts') return route.fulfill({ json: { accounts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  // open settings unless the caller needs to inspect the aggregate indicator first
  if (options.open !== false) await page.getByRole('button', { name: 'Global settings' }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

// open the shared agent chooser from the global launcher
async function openAgentMenu(page: import('@playwright/test').Page) {
  await page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: /^Launch agent/u }).click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Choose agent' }).first().click();
  return page.getByRole('menu', { name: 'Choose agent' });
}

test('hides agents in settings while keeping Codex accounts', async ({ page }) => {
  const settingsPage = await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: '/opt/claude is not an executable file', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex' });
  await expect(settingsPage.getByRole('radiogroup', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toBeVisible();
});

test('changes the default agent from the launch menu', async ({ page }) => {
  let selected: string | undefined;
  await openSettings(page, {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  }, { defaultAgent: 'codex', onDefaultAgent: kind => { selected = kind; }, open: false });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('menuitemradio', { name: 'Make Codex default' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Make Claude default' }).click();
  await expect.poll(() => selected).toBe('claude');
  await expect(menu.getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
});

test('shows agent versions and updates in launch menu with indicator on launch button', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    defaultAgent: 'omx', open: false,
    agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.21.3', updateAvailable: false }
    ],
    onAgentUpdate: kind => ({ kind, currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false })
  });
  const launch = page.getByRole('tablist', { name: 'Agents and worktrees' }).getByRole('button', { name: /^Launch agent/u });
  const settings = page.getByRole('button', { name: 'Global settings' });
  await expect(launch.locator('.new-agent-update-dot')).toBeVisible();
  await expect(launch).toHaveAccessibleName('Launch agent — update available');
  await expect(settings.locator('.server-switcher-settings-update-dot')).toHaveCount(0);
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => launch.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(launch.locator('.new-agent-update-dot')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.21.3', { exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' }).click();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Update Codex/u })).toHaveCount(0);
  await expect(launch.locator('.new-agent-update-dot')).toHaveCount(0);
  await expect(launch).toHaveAccessibleName('Launch agent');
});

test('keeps version errors visible while changing the default agent', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: true, stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'codex', open: false, agentUpdates: [{ kind: 'codex', updateAvailable: false, error: 'Version check failed' }] });
  const menu = await openAgentMenu(page);
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
  await menu.getByRole('group', { name: 'Claude agent' }).getByRole('menuitemradio', { name: 'Make Claude default' }).click();
  await expect(menu.getByRole('group', { name: 'Claude agent' }).getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('alert')).toHaveText('Version check failed');
});

test('marks an unavailable persisted default in the launch menu', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    claude: { program: '/opt/claude', launchable: false, unavailableReason: 'Not executable', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, { defaultAgent: 'claude', open: false });
  const menu = await openAgentMenu(page);
  const claude = menu.getByRole('group', { name: 'Claude agent' });
  await expect(claude.getByRole('menuitemradio', { name: 'Make Claude default' })).toHaveAttribute('aria-checked', 'true');
  await expect(claude.getByRole('menuitemradio', { name: 'Make Claude default' })).toBeDisabled();
  await expect(claude.getByRole('menuitem', { name: /Claude/u })).toBeDisabled();
});

test('enables Davo and saves a configurable name and context', async ({ page }) => {
  const updates: Array<{ enabled: boolean; name: string; context: string }> = [];
  const settingsPage = await openSettings(page, {}, { onDavo: settings => { updates.push(settings); } });
  const enabled = settingsPage.getByRole('switch', { name: 'Enable Davo' });
  const davoSection = settingsPage.locator('.client-settings-davo');
  const switchTrack = davoSection.locator('.client-settings-switch-track');

  await expect(enabled).not.toBeChecked();
  const [davoBounds, switchBounds] = await Promise.all([davoSection.boundingBox(), switchTrack.boundingBox()]);
  // keep the switch on the setting's right edge
  if (davoBounds === null || switchBounds === null) throw new Error('Davo switch has no layout bounds');
  expect(Math.abs(davoBounds.x + davoBounds.width - switchBounds.x - switchBounds.width)).toBeLessThanOrEqual(1);
  const offBackground = await switchTrack.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(settingsPage.getByLabel('Davo name')).toHaveCount(0);
  await enabled.check();
  await expect(switchTrack).not.toHaveCSS('background-color', offBackground);
  await expect(settingsPage.getByLabel('Davo name')).toHaveValue('Davo');
  await expect(settingsPage.getByLabel('Davo context')).toHaveValue('Existing Davo persona.');
  await settingsPage.getByLabel('Davo name').fill('Riley');
  await expect(settingsPage.getByRole('heading', { name: 'Riley' })).toBeVisible();
  await expect(settingsPage.getByRole('switch', { name: 'Enable Riley' })).toBeChecked();
  await settingsPage.getByLabel('Davo context').fill('Speak plainly and keep the tone dry.');
  await settingsPage.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => updates).toEqual([
    { enabled: true, name: 'Davo', context: 'Existing Davo persona.' },
    { enabled: true, name: 'Riley', context: 'Speak plainly and keep the tone dry.' }
  ]);
  await expect(settingsPage.getByText('Saved.')).toBeVisible();
  await expect(settingsPage).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Back to console' }).click();
  await expect(page.getByRole('button', { name: 'Call Riley' }).first()).toBeVisible();
});

test('hides agent and Codex account settings on an observe-only console', async ({ page }) => {
  const settingsPage = await openSettings(page, {});
  await expect(settingsPage.getByRole('radiogroup', { name: 'Agents' })).toHaveCount(0);
  await expect(settingsPage.getByRole('button', { name: '+ Add account' })).toHaveCount(0);
  // client and server settings remain available
  await expect(settingsPage.getByRole('group', { name: 'Client' })).toBeVisible();
  await expect(settingsPage.getByRole('group', { name: 'Server' })).toBeVisible();
});

test('opens settings as a full-screen page from a gear and returns focus to the console', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 812 });
  const settingsPage = await openSettings(page, {});
  const trigger = page.getByRole('button', { name: 'Global settings' });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(trigger.locator('svg')).toHaveCount(1);
  await expect(trigger).toHaveText('');
  await expect(page.getByRole('menu', { name: 'Global settings' })).toHaveCount(0);
  const bounds = await settingsPage.boundingBox();
  expect(bounds).not.toBeNull();
  // require measurable viewport coverage
  if (bounds === null) throw new Error('Settings page has no layout bounds');
  expect(Math.abs(bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.width - 428)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.height - 812)).toBeLessThanOrEqual(1);
  const clientBounds = await settingsPage.getByRole('group', { name: 'Client' }).boundingBox();
  const serverBounds = await settingsPage.getByRole('group', { name: 'Server' }).boundingBox();
  const terminalBounds = await settingsPage.getByRole('group', { name: 'Terminal font' }).boundingBox();
  // retain visible breathing room between flat settings
  if (clientBounds === null || serverBounds === null || terminalBounds === null) throw new Error('Settings have no layout bounds');
  const clientServerGap = serverBounds.y - (clientBounds.y + clientBounds.height);
  const serverTerminalGap = terminalBounds.y - (serverBounds.y + serverBounds.height);
  expect(clientServerGap).toBeGreaterThanOrEqual(12);
  expect(serverTerminalGap).toBeGreaterThanOrEqual(12);
  expect(Math.abs(clientServerGap - serverTerminalGap)).toBeLessThanOrEqual(4);
  const back = settingsPage.getByRole('button', { name: 'Back to console' });
  await back.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(settingsPage.getByRole('switch', { name: 'Enable Davo' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settingsPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// keep long-running codex and omx updates attached to one queued job
test('polls queued Codex and OMX updates through completion', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    open: false, agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.22.0', updateAvailable: true }
    ]
  });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  const posts: Record<string, number> = { codex: 0, omx: 0 };
  const polls: Record<string, number> = { codex: 0, omx: 0 };
  const complete = new Set<string>();
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const start = /^\/api\/agents\/(codex|omx)\/update$/u.exec(url.pathname);
    // queue one update without holding the request open
    if (start !== null && request.method() === 'POST') {
      const kind = start[1]!;
      posts[kind] = (posts[kind] ?? 0) + 1;
      expect(request.headers().prefer).toBe('respond-async');
      return route.fulfill({ status: 202, json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    const poll = /^\/api\/agents\/(codex|omx)\/update\/([^/]+)$/u.exec(url.pathname);
    // return only the requested job identity
    if (poll !== null && request.method() === 'GET') {
      const kind = poll[1]!;
      expect(poll[2]).toBe(`update-${kind}`);
      polls[kind] = (polls[kind] ?? 0) + 1;
      // finish only after the test releases the job
      if (complete.has(kind)) return route.fulfill({ json: { update: { id: `update-${kind}`, kind, state: 'complete', agent: { kind, currentVersion: kind === 'codex' ? '0.153.2' : '0.22.0', latestVersion: kind === 'codex' ? '0.153.2' : '0.22.0', updateAvailable: false } } } });
      return route.fulfill({ json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    return route.fallback();
  });

  const codexUpdate = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  const omxUpdate = menu.getByRole('menuitem', { name: 'Update OMX to 0.22.0' });
  await codexUpdate.click();
  await expect.poll(() => polls.codex).toBeGreaterThan(0);
  await expect(codexUpdate).toContainText('Updating…');
  await expect(codexUpdate).toBeDisabled();
  await expect(omxUpdate).toBeDisabled();
  const codexPolls = polls.codex;
  await page.clock.fastForward(126_000);
  await expect.poll(() => polls.codex).toBeGreaterThan(codexPolls);
  await expect(codexUpdate).toContainText('Updating…');
  await expect(codexUpdate).toBeDisabled();
  expect(posts.codex).toBe(1);
  complete.add('codex');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  await expect(codexUpdate).toHaveCount(0);

  await omxUpdate.click();
  await expect.poll(() => polls.omx).toBeGreaterThan(0);
  await expect(omxUpdate).toContainText('Updating…');
  expect(posts.omx).toBe(1);
  complete.add('omx');
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.22.0', { exact: true })).toBeVisible();
  await expect(omxUpdate).toHaveCount(0);
  expect(posts).toEqual({ codex: 1, omx: 1 });
});

// recover one queued update after a proxy timeout page
test('recovers agent update polling after a transient HTML 524 response', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // queue exactly one update
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      expect(request.headers().prefer).toBe('respond-async');
      return route.fulfill({ status: 202, json: { update: { id: 'update-recovery', kind: 'codex', state: 'running' } } });
    }
    // recover after one gateway timeout page
    if (url.pathname === '/api/agents/codex/update/update-recovery' && request.method() === 'GET') {
      polls += 1;
      // simulate a proxy-owned timeout response
      if (polls === 1) return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
      return route.fulfill({ json: { update: { id: 'update-recovery', kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } } });
    }
    return route.fallback();
  });

  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect.poll(() => polls).toBe(1);
  await expect(update).toContainText('Updating…');
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
  await page.clock.runFor(1_001);
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.153.2', { exact: true })).toBeVisible();
  expect({ posts, polls }).toEqual({ posts: 1, polls: 2 });
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// surface one terminal job failure without disconnecting the console
test('reports a failed queued agent update without global reconnect', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  let posts = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // queue one failing update
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 202, json: { update: { id: 'update-failed', kind: 'codex', state: 'running' } } });
    }
    // publish one terminal command failure
    if (url.pathname === '/api/agents/codex/update/update-failed' && request.method() === 'GET') return route.fulfill({ json: { update: { id: 'update-failed', kind: 'codex', state: 'failed', error: 'Agent update failed after starting.' } } });
    return route.fallback();
  });

  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(menu.getByRole('alert')).toHaveText('Agent update failed after starting.');
  await expect(update).toBeEnabled();
  expect(posts).toBe(1);
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// reject stale and mismatched queued update identities
test('rejects stale and mismatched agent update jobs', async ({ page }) => {
  const adapters = {
    codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { program: '/usr/local/bin/omx', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }
  };
  await openSettings(page, adapters, {
    open: false, agentUpdates: [
      { kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true },
      { kind: 'omx', currentVersion: '0.21.3', latestVersion: '0.22.0', updateAvailable: true }
    ]
  });
  const menu = await openAgentMenu(page);
  const posts: Record<string, number> = { codex: 0, omx: 0 };
  const staleMessage = 'Agent update status is unknown. Check the installed version before retrying.';
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const start = /^\/api\/agents\/(codex|omx)\/update$/u.exec(url.pathname);
    // queue one job for each adapter
    if (start !== null && request.method() === 'POST') {
      const kind = start[1]!;
      posts[kind] = (posts[kind] ?? 0) + 1;
      return route.fulfill({ status: 202, json: { update: { id: `update-${kind}`, kind, state: 'running' } } });
    }
    // expire the codex job before its first poll
    if (url.pathname === '/api/agents/codex/update/update-codex' && request.method() === 'GET') return route.fulfill({ status: 404, json: { error: staleMessage } });
    // return a completed job for the wrong identity
    if (url.pathname === '/api/agents/omx/update/update-omx' && request.method() === 'GET') return route.fulfill({ json: { update: { id: 'update-other', kind: 'codex', state: 'complete', agent: { kind: 'codex', currentVersion: '0.153.2', latestVersion: '0.153.2', updateAvailable: false } } } });
    return route.fallback();
  });

  const codexUpdate = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await codexUpdate.click();
  await expect(menu.getByRole('alert')).toHaveText(staleMessage);
  await expect(codexUpdate).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'Codex agent' }).getByText('v0.152.1 → v0.153.2', { exact: true })).toBeVisible();

  const omxUpdate = menu.getByRole('menuitem', { name: 'Update OMX to 0.22.0' });
  await omxUpdate.click();
  await expect(menu.getByRole('alert')).toBeVisible();
  await expect(menu.getByRole('alert')).not.toHaveText(staleMessage);
  await expect(omxUpdate).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'OMX agent' }).getByText('v0.21.3 → v0.22.0', { exact: true })).toBeVisible();
  expect(posts).toEqual({ codex: 1, omx: 1 });
});

// stop polling one uncertain job after the bounded wait
test('stops transient agent update polling at the seven-minute deadline', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  await page.clock.install();
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // accept exactly one installer request
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 202, json: { update: { id: 'update-deadline', kind: 'codex', state: 'running' } } });
    }
    // keep every status read transiently unavailable
    if (url.pathname === '/api/agents/codex/update/update-deadline' && request.method() === 'GET') {
      polls += 1;
      return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
    }
    return route.fallback();
  });

  const unknownStatus = 'Update status is unavailable. The update may still be running; check installed versions before retrying.';
  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(update).toContainText('Updating…');
  await page.clock.runFor(1_001);
  await expect.poll(() => polls).toBeGreaterThan(0);
  await page.clock.fastForward(420_000);
  await expect(menu.getByRole('alert')).toHaveText(unknownStatus);
  await expect(update).toBeEnabled();
  expect(posts).toBe(1);
  expect(polls).toBeGreaterThan(0);
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});

// never replay one installer after an ambiguous start response
test('does not retry an agent update POST after an HTML 524 response', async ({ page }) => {
  const adapters = { codex: { program: '/usr/local/bin/codex', launchable: true, stateSource: 'title', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false } };
  await openSettings(page, adapters, { open: false, agentUpdates: [{ kind: 'codex', currentVersion: '0.152.1', latestVersion: '0.153.2', updateAvailable: true }] });
  const menu = await openAgentMenu(page);
  let posts = 0;
  let polls = 0;
  await page.route('**/api/agents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // lose the installer acceptance response at the proxy
    if (url.pathname === '/api/agents/codex/update' && request.method() === 'POST') {
      posts += 1;
      return route.fulfill({ status: 524, contentType: 'text/html', body: '<!doctype html><h1>A timeout occurred</h1>' });
    }
    // count any unsafe follow-up status requests
    if (/^\/api\/agents\/codex\/update\//u.test(url.pathname) && request.method() === 'GET') {
      polls += 1;
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
    return route.fallback();
  });

  const unknownStatus = 'Update status is unavailable. The update may still be running; check installed versions before retrying.';
  const update = menu.getByRole('menuitem', { name: 'Update Codex to 0.153.2' });
  await update.click();
  await expect(menu.getByRole('alert')).toHaveText(unknownStatus);
  await expect(update).toBeEnabled();
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await page.waitForTimeout(1_100);
  expect({ posts, polls }).toEqual({ posts: 1, polls: 0 });
  await expect(page.getByRole('alert', { name: 'Reconnecting to console' })).toHaveCount(0);
});
