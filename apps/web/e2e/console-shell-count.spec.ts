import { expect, test } from '@playwright/test';

// A Worktree carries a Console-shell count (`consoleShells`) on its dashboard row. The launcher
// row shows it, the Remove control is refused with a reason while shells are open, and an idle
// (agentless, unpinned) Worktree keeps its tab as long as the count is above zero — so stopping
// the Agent never hides the operator's terminals. (First-class terminal panes, Console shells.)
test('shows the Console-shell count, blocks Remove, and retains an agentless tab', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
        { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
        // an idle, unpinned Worktree with open Console shells — no draft, not sleeping
        { id: 'repo:/repo/feature', projectId: 'repo', label: 'Feature', path: '/repo/feature', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feature', consoleShells: 2 }
      ] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');

  // the agentless Worktree keeps a tab purely because it has open Console shells
  await expect(page.getByRole('tab', { name: /Feature/u })).toBeVisible();

  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const featureRow = launcher.locator('.launcher-row', { hasText: 'Feature' });

  // the row shows the open-terminal count
  await expect(featureRow.locator('.launcher-shells')).toHaveText('2');
  await expect(featureRow.locator('.launcher-shells')).toHaveAttribute('aria-label', '2 open terminals');

  // Remove is refused with the reason while shells are open
  const remove = featureRow.locator('.launcher-remove');
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute('title', 'End the open terminals before removing this worktree');
});
