import { expect, test } from '@playwright/test';

// the Add-a-Worktree flow: each project section carries a "New worktree…" control that
// opens a dialog with a new-branch and an existing-branch mode, and POSTs the choice
const dashboard = {
  generation: 1,
  agents: [],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, worktrees: [
      { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] },
    { id: 'ro', label: 'Mounted Elsewhere', available: true, manageWorktrees: false, manageWorktreesReason: 'the container does not mount this project at its host path, so git cannot manage its worktrees', worktrees: [
      { id: 'ro:/ro', projectId: 'ro', label: 'Mounted Elsewhere', path: '/ro', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }
    ] }
  ]
};

async function stub(page: import('@playwright/test').Page, onCreate: (body: unknown) => void) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/projects/repo/branches') return route.fulfill({ json: { branches: [
      { name: 'main', ref: 'main', remote: false, checkedOut: true },
      { name: 'feature', ref: 'feature', remote: false, checkedOut: false },
      { name: 'hotfix', ref: 'origin/hotfix', remote: true, checkedOut: false }
    ], defaultBranch: 'main' } });
    if (url.pathname === '/api/projects/repo/worktrees' && request.method() === 'POST') {
      onCreate(request.postDataJSON());
      return route.fulfill({ status: 201, json: { worktreeId: 'repo:/repo/wts/feature-login' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('creates a worktree for a new branch with the default base pre-filled', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // the manageable project offers New worktree…; the bridge-unmounted one has it disabled
  const manageable = launcher.getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' });
  await expect(manageable).toBeEnabled();
  const blocked = launcher.getByRole('group', { name: 'Mounted Elsewhere' }).getByRole('button', { name: 'New worktree…' });
  await expect(blocked).toBeDisabled();
  await expect(blocked).toHaveAttribute('title', /does not mount this project/u);

  await manageable.click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog).toBeVisible();
  // the base is a picker over every branch — the checked-out default included — pre-selected
  // to the resolved default branch
  const baseSelect = dialog.getByLabel('Base');
  await expect(baseSelect.locator('option')).toHaveText(['main', 'feature', 'hotfix (remote)']);
  await expect(baseSelect).toHaveValue('main');
  // a branch name is not a credential: password managers are told to leave the field alone
  const branchName = dialog.getByLabel('Branch name');
  await expect(branchName).toHaveAttribute('autocomplete', 'off');
  await expect(branchName).toHaveAttribute('data-1p-ignore', 'true');
  await branchName.fill('feature/login');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'new', branch: 'feature/login', base: 'main', launch: true });
  // the dialog closes once the worktree is created
  await expect(dialog).toBeHidden();
});

test('bases a new branch on a chosen branch, sending the ref that resolves it', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  await page.getByRole('group', { name: 'Agent launcher' }).getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });

  await dialog.getByLabel('Branch name').fill('feature/login');
  await dialog.getByLabel('Base').selectOption('origin/hotfix');
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'new', branch: 'feature/login', base: 'origin/hotfix', launch: true });
});

test('checks out an existing branch, hiding checked-out ones and marking remote-only ones', async ({ page }) => {
  let created: unknown;
  await stub(page, body => { created = body; });
  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  await launcher.getByRole('group', { name: 'Repo' }).getByRole('button', { name: 'New worktree…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New worktree' });

  await dialog.getByRole('tab', { name: 'Existing branch' }).click();
  const select = dialog.getByLabel('Branch', { exact: true });
  await expect(select.locator('option')).toHaveText(['feature', 'hotfix (remote)']);
  await select.selectOption('origin/hotfix');
  // opt out of launching so only the checkout is created
  await dialog.getByLabel('Launch agent in the new worktree').uncheck();
  await dialog.getByRole('button', { name: 'Create worktree' }).click();

  await expect.poll(() => created).toEqual({ mode: 'existing', branch: 'hotfix', launch: false });
});
