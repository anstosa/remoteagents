import { expect, test } from '@playwright/test';

// the Remove and Prune flows: an idle linked Worktree's launcher row offers Remove (hidden
// on Main, disabled when locked), the dialog decides with fresh facts, and a Project with
// stale checkouts offers "N stale · Prune".
const dashboard = {
  generation: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, stalePaths: ['/repo/wts/gone', '/repo/wts/orphan'], worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
      { id: 'repo:/repo/wts/feat', projectId: 'repo', label: 'Repo · feat', path: '/repo/wts/feat', main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch: 'feat' },
      { id: 'repo:/repo/wts/held', projectId: 'repo', label: 'Repo · held', path: '/repo/wts/held', main: false, detached: false, locked: true, available: true, pinned: false, order: 2, branch: 'held' }
    ] }
  ]
};

const facts = { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 2, pushed: true, merged: false, ahead: 1, behind: 0, blockers: [] };

async function stub(page: import('@playwright/test').Page, handlers: { onDelete?: (body: unknown) => void; onPrune?: () => void; removal?: unknown } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    // the Worktree wire id carries `:` and `/`, so decode the encoded path before matching
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/worktrees/repo:/repo/wts/feat/removal') return route.fulfill({ json: handlers.removal ?? facts });
    if (path === '/api/worktrees/repo:/repo/wts/feat' && request.method() === 'DELETE') {
      handlers.onDelete?.(request.postDataJSON());
      return route.fulfill({ status: 200, json: { removed: true } });
    }
    if (path === '/api/projects/repo/worktrees/prune' && request.method() === 'POST') {
      handlers.onPrune?.();
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('removes a linked worktree with discard and branch-delete from the launcher', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { onDelete: body => { deleted = body; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // Main has no Remove; a locked linked worktree's Remove is disabled with its reason
  await expect(launcher.getByRole('button', { name: 'Remove Repo', exact: true })).toHaveCount(0);
  const lockedRemove = launcher.getByRole('button', { name: 'Remove Repo · held' });
  await expect(lockedRemove).toBeDisabled();
  await expect(lockedRemove).toHaveAttribute('title', 'Locked worktrees cannot be removed');

  await launcher.getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toBeVisible();
  // the fresh facts render, a dirty tree needs the discard tick, and the branch is deletable
  await expect(dialog.getByText('2 uncommitted changes')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
  await dialog.getByLabel('Discard uncommitted changes').check();
  await dialog.getByLabel(/Also delete branch/u).check();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();

  await expect.poll(() => deleted).toEqual({ discardChanges: true, deleteBranch: true });
  await expect(dialog).toBeHidden();
});

test('removes a linked worktree from the idle tab power menu', async ({ page }) => {
  let deleted: unknown;
  await stub(page, { onDelete: body => { deleted = body; } });
  await page.goto('/');
  // the pinned idle worktree has its own tab; open it, then its power menu → Remove
  await page.getByRole('tab', { name: /Repo · feat/u }).click();
  await page.getByRole('button', { name: 'Worktree power options' }).click();
  await page.getByRole('menuitem', { name: 'Remove worktree' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Discard uncommitted changes').check();
  await dialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect.poll(() => deleted).toEqual({ discardChanges: true, deleteBranch: false });
});

test('keeps a branch that is neither pushed nor merged, disabling the checkbox', async ({ page }) => {
  await stub(page, { removal: { ...facts, dirtyCount: 0, pushed: false, merged: false } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });

  const branchOption = dialog.getByLabel(/Also delete branch/u);
  await expect(branchOption).toBeDisabled();
  await expect(dialog.getByText('neither pushed nor merged')).toBeVisible();
  // a clean tree removes with no discard needed
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeEnabled();
});

test('refuses removal while a blocker runs', async ({ page }) => {
  await stub(page, { removal: { ...facts, dirtyCount: 0, blockers: ['a running agent'] } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('button', { name: 'Remove Repo · feat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree' });

  await expect(dialog.getByText(/Cannot remove while a running agent is running/u)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove worktree', exact: true })).toBeDisabled();
});

test('prunes a project\'s stale checkouts from the launcher header', async ({ page }) => {
  let pruned = false;
  await stub(page, { onPrune: () => { pruned = true; } });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  await launcher.getByRole('button', { name: '2 stale · Prune' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  await expect(dialog).toBeVisible();
  // both stale paths are listed by path, with the bridge warning
  await expect(dialog.getByText('/repo/wts/gone')).toBeVisible();
  await expect(dialog.getByText('/repo/wts/orphan')).toBeVisible();
  await expect(dialog.getByText(/does not mount can look stale/u)).toBeVisible();
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();

  await expect.poll(() => pruned).toBe(true);
  await expect(dialog).toBeHidden();
});
