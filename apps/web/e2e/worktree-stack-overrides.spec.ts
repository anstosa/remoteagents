import { expect, test } from '@playwright/test';

// tolerate shared-host validation load
test.setTimeout(90_000);

// keep stack controls bound to each checkout
test('renders independent stack URLs and actions for worktrees in one project', async ({ page }) => {
  // serve checkout-specific dashboard state
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose active, idle, and stack-free checkouts
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{
        id: 'agent-cora',
        sessionId: 'socket:$1',
        workspace: '/worktrees/cora',
        projectId: 'potato',
        worktreeId: 'potato:/worktrees/cora',
        title: 'Running tests',
        attention: 'working',
        queuedPromptCount: 0,
        projectUrl: 'https://cora.example.com',
        stack: { actions: ['start', 'stop', 'build', 'restart', 'migrate'], running: true, tunnel: true }
      }],
      projects: [{
        id: 'potato',
        label: 'Potato',
        available: true,
        worktrees: [
          {
            id: 'potato:/worktrees/cora',
            projectId: 'potato',
            label: 'Cora',
            path: '/worktrees/cora',
            main: true,
            detached: false,
            locked: false,
            available: true,
            pinned: true,
            order: 0,
            projectUrl: 'https://cora.example.com',
            stack: { actions: ['start', 'stop', 'build', 'restart', 'migrate'], running: true, tunnel: true }
          },
          {
            id: 'potato:/worktrees/owen',
            projectId: 'potato',
            label: 'Owen',
            path: '/worktrees/owen',
            main: false,
            detached: false,
            locked: false,
            available: true,
            pinned: true,
            order: 1,
            projectUrl: 'https://owen.example.com',
            stack: { actions: ['start', 'stop', 'build', 'restart'], running: true, tunnel: true }
          },
          {
            id: 'potato:/worktrees/alex',
            projectId: 'potato',
            label: 'Alex',
            path: '/worktrees/alex',
            main: false,
            detached: false,
            locked: false,
            available: true,
            pinned: true,
            order: 2,
            stack: { actions: [] }
          }
        ]
      }]
    } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide empty agent collections
    if (/^\/api\/agents\/agent-cora\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // provide empty worktree notes
    if (/^\/api\/worktrees\/potato%3A%2Fworktrees%2F(?:cora|owen|alex)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    // reject unrelated requests
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const panel = page.getByRole('tabpanel');

  await expect(page.getByRole('tab', { name: 'Cora — Working' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://cora.example.com');
  await panel.getByRole('button', { name: 'Stack controls' }).click();
  await expect(page.getByRole('button', { name: 'Migrate stack' })).toBeVisible();
  // reset the menu without depending on its private markup
  await page.reload();

  await page.getByRole('tab', { name: 'Owen — Agent closed' }).click();
  await expect(panel.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://owen.example.com');
  await panel.getByRole('button', { name: 'Stack controls' }).click();
  await expect(page.getByRole('button', { name: 'Restart stack' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Migrate stack' })).toHaveCount(0);
  // reset the menu before checking the stack-free checkout
  await page.reload();

  await page.getByRole('tab', { name: 'Alex — Agent closed' }).click();
  await expect(panel.getByRole('group', { name: 'Project controls' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stack controls' })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Open' })).toHaveCount(0);
});
