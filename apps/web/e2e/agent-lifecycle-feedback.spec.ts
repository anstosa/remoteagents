import { expect, test, type Page } from '@playwright/test';

// verify lifecycle feedback names the chosen launch agent
test('keeps agent on/off progress visible across lifecycle transitions', async ({ page }) => {
  let agentRunning = true;
  let agentId = 'agent-1';
  let finishDeactivate!: () => void;
  let finishLaunch!: () => void;
  const deactivateFinished = new Promise<void>(resolve => { finishDeactivate = resolve; });
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });
  const adapters = {
    codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false },
    omx: { launchable: true, program: '/bin/omx', stateSource: 'title', turnCapture: true, inlineQuestions: true, commands: true, sandbox: false }
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: agentRunning
          ? { generation: agentId === 'agent-1' ? 1 : 3, adapters, agents: [{ id: agentId, sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', launch: { kind: 'codex', origin: 'worktree' } }], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }] }
          : { generation: 2, adapters, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 0, launch: { kind: 'codex', origin: 'worktree' } }, { id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1 }] }] }
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
  await expect(powerMenu.getByRole('menuitem', { name: 'Sleep' })).toHaveCount(0);
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
  // the agentless Worktree view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();

  await page.locator('.prompt-actions').getByRole('button', { name: 'Choose agent' }).click();
  await page.getByRole('menu', { name: 'Choose agent' }).getByRole('menuitem', { name: /^OMX/u }).click();
  const pendingLaunch = page.getByRole('status').filter({ hasText: 'Starting Cora' });
  await expect(pendingLaunch).toContainText('waiting for the agent session to become ready');
  await expect(page.getByRole('tab', { name: 'Cora — Starting agent' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Starting OMX at Cora…', { exact: true })).toBeVisible();
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: agentId === 'agent-1' ? 1 : 2, adapters: { codex: { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false }, claude: { launchable: true, program: '/bin/claude', stateSource: 'reported', turnCapture: false, inlineQuestions: false, commands: true, sandbox: false } }, agents: [{ id: agentId, sessionId: agentId === 'agent-1' ? 'socket:$1' : 'socket:$2', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', kind: 'codex', attention: 'finished', launch: { kind: 'codex', origin: 'worktree' } }], projects: [] } });
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

// serve one idle agent in Cora whose Turn off closes it, with Cora pinned or not
const mountTurnOff = async (page: Page, pinned: boolean) => {
  let running = true;
  let turnOffRequests = 0;
  const cora = { id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned, order: 0 };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the agent until it is turned off
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: running ? 1 : 2, agents: running ? [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }] : [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [cora] }] } });
    // disable push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide live agent resources
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // provide empty worktree notes
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // close the agent
    if (url.pathname === '/api/agents/agent-1/deactivate' && request.method() === 'POST') {
      turnOffRequests += 1;
      running = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { turnOffRequests: () => turnOffRequests };
};

// verify Turn off is the only way to stop an idle agent, and a Pinned Worktree keeps its tab
test('turns off an idle agent and keeps the tab of its pinned worktree', async ({ page }) => {
  const harness = await mountTurnOff(page, true);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  const powerMenu = page.getByRole('menu', { name: 'Agent power options' });
  await expect(powerMenu.getByRole('menuitem')).toHaveText(['Restart', 'Clear', 'Turn off']);
  await powerMenu.getByRole('menuitem', { name: 'Turn off' }).click();

  await expect.poll(harness.turnOffRequests).toBe(1);
  await expect(page.getByRole('tab', { name: 'Cora — Agent closed' })).toBeVisible();
  await expect(page.getByText('Agent is off', { exact: true })).toBeVisible();
  // the agentless Worktree view has no floating server switcher; the tab row leads with it
  await expect(page.locator('.server-switcher, .output-server-switcher')).toHaveCount(0);
  await expect(page.locator('.tabs > .tab-row-lead .server-selector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake up' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Worktree power options' }).click();
  await expect(page.getByRole('menu', { name: 'Worktree power options' }).getByRole('menuitem')).toHaveText(['Rename worktree', 'Remove worktree']);
});

// verify an unpinned Worktree's tab closes with its agent
test('turns off an idle agent and drops the tab of its unpinned worktree', async ({ page }) => {
  const harness = await mountTurnOff(page, false);
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Turn off' }).click();

  await expect.poll(harness.turnOffRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
});

// verify a failed restart stays visible after the unpinned worktree's tab closes
test('reports a failed restart even when the unpinned worktree tab closes', async ({ page }) => {
  let running = true;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: running ? 1 : 2, agents: running ? [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }] : [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, order: 0 }] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-1\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // the server closes the agent, then the resume fails
    if (url.pathname === '/api/agents/agent-1/restart' && request.method() === 'POST') {
      running = false;
      return route.fulfill({ status: 409, json: { error: 'The agent closed, but it could not be resumed.' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menu', { name: 'Agent power options' }).getByRole('menuitem', { name: 'Restart', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Cora could not restart' })).toContainText('could not be resumed');
});
