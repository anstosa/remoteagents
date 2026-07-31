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
