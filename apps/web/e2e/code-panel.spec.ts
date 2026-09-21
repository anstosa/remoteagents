import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import type { ComparisonFile, ComparisonPatch } from '../src/code-panel/comparison';

// a minimal but valid git unified diff for one modified file, enough for parsePatchFiles
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;

const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const cappedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path }, kind: 'tracked', patch: '', capped: true });

const patchOf = (files: ComparisonFile[], truncated = false): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => file.change.path).join('|'), truncated });

// mount the isolated Code panel with a scripted Comparison
const mountPanel = async (page: Page, patch: ComparisonPatch) => {
  await page.goto('/');
  await page.evaluate(async scripted => {
    const { renderCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    document.body.replaceChildren(root);
    renderCodePanel(root, scripted);
  }, patch);
};

const panel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const diffHeaders = (page: Page) => page.locator('.code-pane diffs-container [data-title]');

test('renders implementation changes and collapses tests & docs by default', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/widget.ts'), trackedFile('src/app.test.ts')]));

  await expect(panel(page).getByText('Working changes')).toBeVisible();
  await expect(panel(page).getByText('3 files')).toBeVisible();
  // only the two implementation files render; the test file is behind the collapsed group
  await expect(diffHeaders(page)).toHaveCount(2);

  const toggle = page.getByRole('button', { name: /tests & docs \(1\)/iu });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  // expanding the supporting group appends the test file to the same scroll
  await expect(diffHeaders(page)).toHaveCount(3);
});

test('covers a size-capped file with a Load anyway placeholder instead of a diff', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), cappedFile('src/generated.ts')]));

  // the capped file is a placeholder, not a rendered diff
  await expect(panel(page).getByText('src/generated.ts')).toBeVisible();
  await expect(panel(page).getByText('File too large to preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load anyway' })).toBeVisible();
  // only the non-capped file rendered a diff
  await expect(diffHeaders(page)).toHaveCount(1);
});

test('opens a Code panel of the Working changes from the Git flyout', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // one active, changed worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }, { code: ' M', path: 'src/app.test.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // the Working Comparison for the panel
    if (url.pathname === '/api/worktrees/cora/comparison') {
      expect(request.postDataJSON()).toEqual({ kind: 'working' });
      return route.fulfill({ json: patchOf([trackedFile('src/app.ts'), trackedFile('src/app.test.ts')]) });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes' }).click();

  await expect(panel(page).getByText('Working changes')).toBeVisible();
  // the implementation file renders; the test file stays behind the collapsed supporting group
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: /tests & docs \(1\)/iu })).toBeVisible();
});
