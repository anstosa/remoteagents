import { expect, test } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';

test('previews a changed file while new agent output arrives', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // return the authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // return one changed active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/file-preview', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'apps/server/src/app.ts', additions: 12, deletions: 3 }] }, title: 'Ready' }], projects: [] } });
    // return log authorization
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty auxiliary data
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // return the selected changed file
    if (url.pathname === '/api/agents/agent-1/file-preview') {
      expect(request.postDataJSON()).toEqual({ path: 'apps/server/src/app.ts' });
      return route.fulfill({ json: { path: 'apps/server/src/app.ts', size: 25, binary: false, truncated: false, content: 'export const app = true;\n' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'Preview apps/server/src/app.ts' }).click();
  const preview = page.getByRole('dialog', { name: 'File preview: apps/server/src/app.ts' });
  await expect(preview.getByLabel('Contents of apps/server/src/app.ts')).toContainText('export const app = true;');

  // new pane output keeps arriving (and renders) while the preview stays open
  await pushBytes(page, 'agent-1', 'Still working\n');
  await expect(page.locator('.log-canvas .xterm-rows')).toContainText('Still working');
  await expect(preview).toBeVisible();
});
