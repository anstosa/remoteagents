import { expect, test } from '@playwright/test';

test('keeps agent on/off progress visible across lifecycle transitions', async ({ page }) => {
  let agentRunning = true;
  let agentId = 'agent-1';
  let finishDeactivate!: () => void;
  let finishLaunch!: () => void;
  const deactivateFinished = new Promise<void>(resolve => { finishDeactivate = resolve; });
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: agentRunning
          ? { generation: agentId === 'agent-1' ? 1 : 3, agents: [{ id: agentId, sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }
          : { generation: 2, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0 }, { id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/deactivate' && request.method() === 'POST') {
      await deactivateFinished;
      agentRunning = false;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/worktrees/cora/launch' && request.method() === 'POST') {
      await launchFinished;
      agentRunning = true;
      agentId = 'agent-2';
      return route.fulfill({ json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem', { name: 'Sleep' })).toBeVisible();
  await powerMenu.getByRole('menuitem', { name: 'Turn off' }).click();

  const pendingOff = page.getByRole('status').filter({ hasText: 'Turning off Cora' });
  await expect(pendingOff).toContainText('Stopping the agent while keeping the worktree available');
  await expect(page.getByRole('tab', { name: 'Cora — Turning off' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(pendingOff).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Turning off' }).click();
  await expect(pendingOff).toBeVisible();

  finishDeactivate();
  const offSuccess = page.getByRole('status').filter({ hasText: 'Cora is off' });
  await expect(offSuccess).toContainText('Launch agent whenever you want to turn it back on');
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByText('Agent is off', { exact: true })).toBeVisible();

  await page.locator('.prompt-actions').getByRole('button', { name: 'Launch agent' }).click();
  const pendingLaunch = page.getByRole('status').filter({ hasText: 'Starting Cora' });
  await expect(pendingLaunch).toContainText('waiting for the agent session to become ready');
  await expect(page.getByRole('tab', { name: 'Cora — Starting agent' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Starting Codex…', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(pendingLaunch).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Starting agent' }).click();
  await expect(pendingLaunch).toBeVisible();

  finishLaunch();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is starting' })).toContainText('output is connecting');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});

// verify non-destructive power actions
test('clears and restarts an idle agent from the power menu', async ({ page }) => {
  let agentId = 'agent-1';
  let clearPrompt: unknown;
  let restartRequests = 0;
  let finishClear!: () => void;
  let finishRestart!: () => void;
  const clearFinished = new Promise<void>(resolve => { finishClear = resolve; });
  const restartFinished = new Promise<void>(resolve => { finishRestart = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: agentId === 'agent-1' ? 1 : 2, adapters: { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false }, claude: { launchable: true, program: '/bin/claude', stateSource: 'reported', turnCapture: false, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: agentId, sessionId: agentId === 'agent-1' ? 'socket:$1' : 'socket:$2', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', attention: 'finished', launch: { kind: 'codex', origin: 'worktree' } }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // hold clear while its progress state is visible
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      clearPrompt = request.postDataJSON();
      await clearFinished;
      return route.fulfill({ status: 204 });
    }
    // hold restart while its progress state is visible
    if (url.pathname === '/api/agents/agent-1/restart' && request.method() === 'POST') {
      restartRequests += 1;
      await restartFinished;
      agentId = 'agent-2';
      return route.fulfill({ status: 201, json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem', { name: 'Restart', exact: true })).toBeVisible();
  await expect(powerMenu.getByRole('menuitem', { name: 'Restart as…' })).toBeVisible();
  await expect(powerMenu.getByRole('menuitem', { name: 'Clear' })).toBeVisible();
  await powerMenu.getByRole('menuitem', { name: 'Clear' }).click();

  await expect.poll(() => clearPrompt).toEqual({ prompt: '/clear', attachments: [] });
  await expect(page.getByRole('status').filter({ hasText: 'Clearing Cora' })).toContainText('Sending /clear');
  await expect(page.getByRole('tab', { name: 'Cora — Clearing' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();

  finishClear();
  await expect(page.getByRole('status').filter({ hasText: 'Cora cleared' })).toContainText('conversation is resetting');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();

  await page.getByRole('button', { name: 'Agent power options' }).click();
  await powerMenu.getByRole('menuitem', { name: 'Restart', exact: true }).click();

  await expect.poll(() => restartRequests).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Restarting Cora' })).toContainText('running the resume alias');
  await expect(page.getByRole('tab', { name: 'Cora — Restarting' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Agent power options' })).toBeDisabled();

  finishRestart();
  await expect(page.getByRole('status').filter({ hasText: 'Cora restarted' })).toContainText('conversation resumed');
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});

test('sleeps an idle agent and wakes the retained tab through resume', async ({ page }) => {
  let state: 'active'|'sleeping' = 'active';
  let agentId = 'agent-1';
  let sleepRequests = 0;
  let wakeRequests = 0;
  let finishWake!: () => void;
  const wakeFinished = new Promise<void>(resolve => { finishWake = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: state === 'active'
      ? { generation: agentId === 'agent-1' ? 1 : 3, agents: [{ id: agentId, sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], worktrees: [] }
      : { generation: 2, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, sleeping: true, projectUrl: 'https://example.test', order: 0 }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // close the process while retaining the sleep state
    if (url.pathname === '/api/agents/agent-1/sleep' && request.method() === 'POST') {
      sleepRequests += 1;
      state = 'sleeping';
      return route.fulfill({ status: 204 });
    }
    // resume only after the wake transition is visible
    if (url.pathname === '/api/worktrees/cora/wake' && request.method() === 'POST') {
      wakeRequests += 1;
      await wakeFinished;
      state = 'active';
      agentId = 'agent-2';
      return route.fulfill({ status: 201, json: { agentId } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Sleep' }).click();

  await expect.poll(() => sleepRequests).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Sleeping' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Cora sleeping', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake up' })).toBeEnabled();
  await expect(page.locator('.prompt-actions').getByRole('button', { name: 'Launch agent' })).toHaveCount(0);
  const powerButtonBounds = await page.getByRole('button', { name: 'Agent power options' }).boundingBox();
  const projectButtonBounds = await page.getByRole('link', { name: 'Open' }).boundingBox();
  expect(powerButtonBounds?.x).toBeLessThan(projectButtonBounds?.x ?? 0);

  await page.getByRole('button', { name: 'Agent power options' }).click();
  const sleepingPowerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(sleepingPowerMenu.getByRole('menuitem')).toHaveText(['Wake up', 'Turn off']);
  await sleepingPowerMenu.getByRole('menuitem', { name: 'Wake up' }).click();
  await expect.poll(() => wakeRequests).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Waking up' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status', { name: 'Waking Cora', exact: true })).toBeVisible();

  finishWake();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is awake' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cora — Prompt done' })).toBeVisible();
});

// verify sleeping-tab permanent shutdown
test('turns off a retained sleeping tab from its power menu', async ({ page }) => {
  let sleeping = true;
  let turnOffRequests = 0;

  // serve one retained sleeping lifecycle
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose or remove the sleeping tab
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: sleeping ? 1 : 2, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, ...(sleeping ? { sleeping: true } : {}), order: 0 }] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide empty worktree notes
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // forget the retained tab
    if (url.pathname === '/api/worktrees/cora/deactivate' && request.method() === 'POST') {
      turnOffRequests += 1;
      sleeping = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem')).toHaveText(['Wake up', 'Turn off']);
  await powerMenu.getByRole('menuitem', { name: 'Turn off' }).click();

  await expect.poll(() => turnOffRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Cora is off' })).toContainText('worktree remains available');
});
