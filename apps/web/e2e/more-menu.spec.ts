import { expect, test } from '@playwright/test';

test('keeps attachments and repository choices out of the more menu', async ({ page }) => {
  let finishGithubActions!: () => void;
  let finishNewTask!: () => void;
  // hold secondary actions through loading assertions
  const githubActionsFinished = new Promise<void>(resolve => { finishGithubActions = resolve; });
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/current', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, title: 'Ready', terminal: true, newTaskConfigured: true }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // delay the fixed menu actions
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') {
      await newTaskFinished;
      return route.fulfill({ json: { enabled: true } });
    }
    // delay the external actions link
    if (url.pathname === '/api/agents/agent-1/github-actions') {
      await githubActionsFinished;
      return route.fulfill({ json: { url: 'https://github.com/octo/repo/actions' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const attachmentShortcut = page.locator('.prompt-action-rail').getByRole('button', { name: 'Attach files', exact: true });
  await expect(attachmentShortcut).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  const menu = page.locator('.more-menu');
  await expect(menu.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0);
  await expect(menu.getByText('Pull requests', { exact: true })).toHaveCount(0);
  await expect(menu.getByText('Branches', { exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Swap to terminal', exact: true }).locator('.more-menu-icon')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'GitHub Actions', exact: true }).locator('.spinner')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'New Task', exact: true }).locator('.spinner')).toBeVisible();
  finishGithubActions();
  finishNewTask();
  await expect(menu.getByRole('link', { name: 'GitHub Actions', exact: true })).toHaveAttribute('href', 'https://github.com/octo/repo/actions');
  await expect(menu.locator('.new-task-option .more-menu-reason')).toHaveText('Start a fresh task for this worktree.');
  await page.keyboard.press('Escape');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await attachmentShortcut.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });
  await expect(page.getByLabel('Selected attachments')).toContainText('notes.txt');
});
