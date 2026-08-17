import { expect, test } from '@playwright/test';

test('keeps a queued prompt pending only on its originating agent tab', async ({ page }) => {
  let finishQueue!: () => void;
  const queueFinished = new Promise<void>(resolve => { finishQueue = resolve; });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: {
          agents: [
            { id: 'agent-alpha', sessionId: 'socket:$1', workspace: '/worktrees/alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' },
            { id: 'agent-bravo', sessionId: 'socket:$2', workspace: '/worktrees/bravo', worktreeLabel: 'Bravo', worktreeOrder: 2, title: 'Ready' }
          ],
          worktrees: []
        }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-alpha/prompt') {
      await queueFinished;
      return route.fulfill({ status: 204 });
    }
    if (/^\/api\/agents\/agent-(?:alpha|bravo)\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Run the alpha checks');
  await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Queueing' })).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  await expect(prompt).toBeEnabled();
  await prompt.fill('Work independently on bravo');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeEnabled();

  await page.getByRole('tab', { name: /^Alpha/u }).click();
  await expect(page.getByRole('button', { name: 'Queueing' })).toBeDisabled();

  finishQueue();
  await expect(prompt).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Queueing' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();
});

test('keeps launch state on its worktree tab and does not pull focus back after navigation', async ({ page }) => {
  let finishLaunch!: () => void;
  const launchFinished = new Promise<void>(resolve => { finishLaunch = resolve; });
  let launched = false;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({
        json: launched ? {
          agents: [{ id: 'agent-alpha', sessionId: 'socket:$1', workspace: '/worktrees/alpha', worktreeId: 'alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' }],
          worktrees: [{ id: 'bravo', label: 'Bravo', path: '/worktrees/bravo', available: true, pinned: true, order: 2 }]
        } : {
          agents: [],
          worktrees: [
            { id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: true, order: 1 },
            { id: 'bravo', label: 'Bravo', path: '/worktrees/bravo', available: true, pinned: true, order: 2 }
          ]
        }
      });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/alpha/launch') {
      await launchFinished;
      launched = true;
      return route.fulfill({ json: { agentId: 'agent-alpha' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launchButton = page.locator('.prompt-actions .queue');
  await launchButton.click();
  await expect(page.getByRole('button', { name: 'Launching' })).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  await expect(launchButton).toBeEnabled();

  await page.getByRole('tab', { name: /^Alpha/u }).click();
  await expect(page.getByRole('button', { name: 'Launching' })).toBeDisabled();

  await page.getByRole('tab', { name: /^Bravo/u }).click();
  finishLaunch();
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Bravo/u })).toHaveAttribute('aria-selected', 'true');
  await expect(launchButton).toBeEnabled();
});

// verify concurrent launcher handoffs
test('creates loading tabs immediately and keeps the worktree launcher available', async ({ page }) => {
  let alphaRunning = false;
  let alphaLaunchReturned = false;
  let alphaPostResponseDashboards = 0;
  let bravoRunning = false;
  let alphaRequests = 0;
  let bravoRequests = 0;
  let finishAlpha!: () => void;
  let finishBravo!: () => void;
  // hold the first launch response
  const alphaFinished = new Promise<void>(resolve => { finishAlpha = resolve; });
  // hold the second launch response
  const bravoFinished = new Promise<void>(resolve => { finishBravo = resolve; });

  // provide independently controlled launch responses
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose active agents and inactive worktrees
    if (url.pathname === '/api/dashboard') {
      // count delayed dashboard propagation
      if (alphaLaunchReturned && !alphaRunning) alphaPostResponseDashboards += 1;
      const agents = [
        ...(alphaRunning ? [{ id: 'agent-alpha', sessionId: 'socket:$1', workspace: '/worktrees/alpha', worktreeId: 'alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' }] : []),
        ...(bravoRunning ? [{ id: 'agent-bravo', sessionId: 'socket:$2', workspace: '/worktrees/bravo', worktreeId: 'bravo', worktreeLabel: 'Bravo', worktreeOrder: 2, title: 'Ready' }] : [])
      ];
      const worktrees = [
        ...(!alphaRunning ? [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, order: 1 }] : []),
        ...(!bravoRunning ? [{ id: 'bravo', label: 'Bravo', path: '/worktrees/bravo', available: true, pinned: false, order: 2 }] : [])
      ];
      return route.fulfill({ json: { generation: 1, agents, worktrees } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide inactive worktree notes
    if (/^\/api\/worktrees\/(?:alpha|bravo)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    // hold alpha until both launches are visible
    if (url.pathname === '/api/worktrees/alpha/launch') {
      alphaRequests += 1;
      await alphaFinished;
      alphaLaunchReturned = true;
      return route.fulfill({ json: { agentId: 'agent-alpha' } });
    }
    // hold bravo independently
    if (url.pathname === '/api/worktrees/bravo/launch') {
      bravoRequests += 1;
      await bravoFinished;
      bravoRunning = true;
      return route.fulfill({ json: { agentId: 'agent-bravo' } });
    }
    // provide active agent bootstrap data
    if (/^\/api\/agents\/agent-(?:alpha|bravo)\/(?:tickets|saved-prompts|prompt-history)$/u.test(url.pathname)) {
      return route.fulfill({ json: url.pathname.endsWith('/tickets') ? { ticket: 'log-ticket' } : { prompts: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launcher = page.getByRole('button', { name: 'Launch agent' });
  const launcherMenu = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.click();
  await launcherMenu.getByRole('button', { name: 'Alpha' }).click();

  const alphaTab = page.getByRole('tab', { name: 'Alpha — Starting agent' });
  await expect(alphaTab).toHaveAttribute('aria-busy', 'true');
  await expect(launcher).toBeEnabled();

  await launcher.click();
  await expect(launcherMenu.getByRole('button', { name: 'Alpha' })).toBeDisabled();
  await launcherMenu.getByRole('button', { name: 'Bravo' }).click();

  const bravoTab = page.getByRole('tab', { name: 'Bravo — Starting agent' });
  await expect(bravoTab).toHaveAttribute('aria-busy', 'true');
  await expect(bravoTab).toHaveAttribute('aria-selected', 'true');
  // observe both launch requests
  await expect.poll(() => ({ alphaRequests, bravoRequests })).toEqual({ alphaRequests: 1, bravoRequests: 1 });

  finishAlpha();
  await expect.poll(() => alphaPostResponseDashboards).toBeGreaterThan(0);
  await expect(alphaTab).toHaveAttribute('aria-busy', 'true');
  await expect(bravoTab).toHaveAttribute('aria-selected', 'true');
  alphaRunning = true;
  await expect(page.getByRole('tab', { name: 'Alpha — Prompt done' })).toBeVisible({ timeout: 10_000 });

  finishBravo();
  await expect(page.getByRole('tab', { name: 'Bravo — Prompt done' })).toHaveAttribute('aria-selected', 'true');
});

// recover worktrees whose launched agent disappears
test('expires a successful launch that never reaches the dashboard', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // keep the launched agent absent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, order: 1 }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // report server-side launch success
    if (url.pathname === '/api/worktrees/alpha/launch') return route.fulfill({ json: { agentId: 'agent-alpha' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launcher = page.getByRole('button', { name: 'Launch agent' });
  await launcher.click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Alpha' }).click();
  await expect(page.getByRole('tab', { name: 'Alpha — Starting agent' })).toHaveAttribute('aria-busy', 'true');

  await page.clock.fastForward(30_001);
  await expect(page.getByRole('alert')).toContainText('Alpha started, but its agent did not remain discoverable. Try again.');
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toHaveCount(0);
  await launcher.click();
  await expect(page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Alpha' })).toBeEnabled();
});

// preserve launch failures after temporary tabs close
test('shows a failed unpinned worktree launch globally', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one launcher-only worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, order: 1 }] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // reject the worktree launch
    if (url.pathname === '/api/worktrees/alpha/launch') return route.fulfill({ status: 502, json: { error: 'Alpha launch failed upstream.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Launch agent' }).click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Alpha' }).click();

  await expect(page.getByRole('alert')).toHaveText('Alpha launch failed upstream.');
  await expect(page.getByRole('tab', { name: /^Alpha/u })).toHaveCount(0);
});

// scope wake state to its launcher action
test('disables a sleeping worktree launcher while wake is pending', async ({ page }) => {
  let running = false;
  let waking = false;
  let interimDashboards = 0;
  let finishWake!: () => void;
  const wakeFinished = new Promise<void>(resolve => { finishWake = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // switch from sleeping through an unpinned transition to an active agent
    if (url.pathname === '/api/dashboard') {
      if (running) return route.fulfill({ json: { generation: 3, agents: [{ id: 'agent-alpha', sessionId: 'socket:$1', workspace: '/worktrees/alpha', worktreeId: 'alpha', worktreeLabel: 'Alpha', worktreeOrder: 1, title: 'Ready' }], worktrees: [] } });
      if (waking) {
        interimDashboards += 1;
        return route.fulfill({ json: { generation: 2, agents: [], worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: false, pinned: false, sleeping: false, order: 1 }] } });
      }
      return route.fulfill({ json: { generation: 1, agents: [], worktrees: [{ id: 'alpha', label: 'Alpha', path: '/worktrees/alpha', available: true, pinned: false, sleeping: true, order: 1 }] } });
    }
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // hold the wake request
    if (url.pathname === '/api/worktrees/alpha/wake') {
      waking = true;
      await wakeFinished;
      running = true;
      return route.fulfill({ json: { agentId: 'agent-alpha' } });
    }
    // provide active agent bootstrap data
    if (/^\/api\/agents\/agent-alpha\/(?:tickets|saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: url.pathname.endsWith('/tickets') ? { ticket: 'log-ticket' } : { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const launcher = page.getByRole('button', { name: 'Launch agent' });
  await launcher.click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Alpha' }).click();
  await launcher.click();
  await expect(page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Alpha' })).toBeDisabled();
  await expect.poll(() => interimDashboards, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('tab', { name: 'Alpha — Waking up' })).toHaveAttribute('aria-busy', 'true');

  finishWake();
  await expect(page.getByRole('tab', { name: 'Alpha — Prompt done' })).toBeVisible();
});
