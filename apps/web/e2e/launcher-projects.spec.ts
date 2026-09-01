import { expect, test } from '@playwright/test';

// the projects[] wire: the "+" launcher groups idle Worktrees under one section per Project,
// and each row carries a Pin toggle that POSTs to /api/worktrees/:id/pin
test('launcher lists per-project sections and pins a worktree', async ({ page }) => {
  const pins: Array<{ id: string; pinned: boolean }> = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
        { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
        { id: 'repo:/repo/feature', projectId: 'repo', label: 'Repo · feature', path: '/repo/feature', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feature' }
      ] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    const pinMatch = /^\/api\/worktrees\/([^/]+)\/pin$/u.exec(url.pathname);
    if (pinMatch && request.method() === 'POST') {
      pins.push({ id: decodeURIComponent(pinMatch[1]), pinned: (request.postDataJSON() as { pinned: boolean }).pinned });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // the main Worktree is pinned, so it already has a tab
  await expect(page.getByRole('tab', { name: /^Repo —/u })).toBeVisible();
  // open the launcher and confirm the per-project section lists both idle Worktrees
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await expect(launcher.locator('.launcher-project-header > span')).toHaveText('Repo');
  // the pinned Main worktree offers an Unpin toggle; the idle feature offers a Pin toggle
  await expect(launcher.getByRole('button', { name: 'Unpin Repo', exact: true })).toBeVisible();
  await launcher.getByRole('button', { name: 'Pin Repo · feature' }).click();
  await expect.poll(() => pins).toContainEqual({ id: 'repo:/repo/feature', pinned: true });
});
