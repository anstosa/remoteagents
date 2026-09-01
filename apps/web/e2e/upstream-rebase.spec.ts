import { expect, test } from '@playwright/test';

test('offers a rebase only when upstream has new commits', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="root"></div>');
  await page.evaluate(async () => {
    const { renderUpstreamRebaseBanners } = await import('/e2e/upstream-rebase-fixture.tsx');
    renderUpstreamRebaseBanners(document.querySelector<HTMLElement>('#root')!);
  });

  const banner = page.getByRole('status', { name: 'origin/feature has 3 new commits' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('origin/feature has 3 new commits. Your branch also has 2 local commits.');
  await expect(page.locator('.upstream-rebase-banner')).toHaveCount(1);
  const rebase = page.getByRole('button', { name: 'Rebase onto origin/feature' });
  await rebase.click();
  await expect(page.locator('#root')).toHaveAttribute('data-rebase', 'queued');
  await expect(rebase).toContainText('Queued');
});

test('queues the tracked upstream rebase workflow from the active branch banner', async ({ page }) => {
  let queuedPrompt: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/console', gitUpstream: { upstream: 'origin/feature/console', ahead: 1, behind: 2 }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Rebase onto origin/feature/console' }).click();

  await expect.poll(() => queuedPrompt).toEqual({ prompt: '$rebase origin/feature/console', attachments: [] });
});

test('hides the branch rebase banner for the Remote Agents host repository', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose a behind host repository agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-remoteagents', sessionId: 'socket:$1', workspace: '/workspace', worktreeId: 'remoteagents', worktreeLabel: 'Remote Agents', branch: 'main', gitUpstream: { upstream: 'origin/main', ahead: 0, behind: 2 }, title: 'Ready' }], projects: [] } });
    // keep the reviewed host updater current for this banner check
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // authorize the visible agent output
    if (url.pathname === '/api/agents/agent-remoteagents/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty prompt stores
    if (/^\/api\/agents\/agent-remoteagents\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Remote Agents/u })).toBeVisible();
  await expect(page.getByText('Upstream updates available')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rebase onto origin/main' })).toHaveCount(0);
});
