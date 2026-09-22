import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import type { ComparisonFile, ComparisonFileContents, ComparisonPatch, RevisionFile } from '../src/code-panel/comparison';

// a minimal but valid git unified diff for one modified file, enough for parsePatchFiles
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;

const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const cappedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path }, kind: 'tracked', patch: '', capped: true });

const patchOf = (files: ComparisonFile[], truncated = false): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => file.change.path).join('|'), truncated });

// The whole file behind `modifiedPatch`, with lines past the hunk (the `sentinel` line) that only
// Plain-file and Full-context modes should surface.
const baseFile = 'const a = 1;\nconst b = 2;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const workingFile = 'const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const revision = (path: string, content: string): RevisionFile => ({ path, size: content.length, binary: false, truncated: false, content });
const contentsOf = (path: string, base: string, working: string): ComparisonFileContents => ({ path, base: revision(path, base), working: revision(path, working) });

// mount the isolated Code panel with a scripted Comparison (and optional per-file revision contents)
const mountPanel = async (page: Page, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}) => {
  await page.goto('/');
  await page.evaluate(async ({ scripted, files }) => {
    const { renderCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    // stretch the panel to fill the root so its 1fr diff row is bounded and can scroll, the way the
    // real split sizes it (a bare block child would size to content and never overflow)
    root.style.display = 'grid';
    document.body.replaceChildren(root);
    renderCodePanel(root, scripted, files);
  }, { scripted: patch, files: loaded });
};

const panel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const diffHeaders = (page: Page) => page.locator('.code-pane diffs-container [data-title]');

test('renders implementation changes and collapses tests & docs by default', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/widget.ts'), trackedFile('src/app.test.ts')]));

  // the panel header carries the Working / All PR comparison toggle, seeded to Working
  await expect(panel(page).getByRole('button', { name: 'Working', exact: true })).toHaveAttribute('aria-pressed', 'true');
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

test('filters to one file from the rail and restores scroll on the way back', async ({ page }) => {
  const files = Array.from({ length: 8 }, (_, index) => trackedFile(`src/mod${index}.ts`));
  await mountPanel(page, patchOf(files));
  // the rail lists every changed file (it is not virtualized like the diff scroll)
  await expect(panel(page).locator('.code-pane-file-row')).toHaveCount(8);
  await expect(panel(page).getByText('8 files')).toBeVisible();
  await expect(diffHeaders(page).first()).toBeVisible();

  // scroll the all-files list down, then leave it for one file
  const view = panel(page).locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const before = await view.evaluate(element => element.scrollTop);

  await panel(page).getByRole('button', { name: 'mod4.ts' }).click();
  await expect(panel(page).getByRole('button', { name: '‹ All files' })).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(1);

  // the breadcrumb returns to every file and lands back at the captured (item, offset) anchor: close
  // to where we left off, not the top and not overshooting
  await panel(page).getByRole('button', { name: '‹ All files' }).click();
  await expect(panel(page).getByText('8 files')).toBeVisible();
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), before)).toBeLessThan(24);
});

test('switches a file between hunks, plain, and full-context modes', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile) });

  // Plain file is single-file only, so it is disabled in the all-files view
  await expect(panel(page).getByRole('button', { name: 'Plain file' })).toBeDisabled();

  await panel(page).getByRole('button', { name: 'app.ts' }).click();
  await expect(panel(page).getByRole('button', { name: '‹ All files' })).toBeVisible();

  // Hunks (default): only the patched lines render, so a line past the hunk stays hidden
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect(panel(page).getByText('const sentinel = 999;')).toHaveCount(0);

  // Full context: still a diff (a header renders), but the unchanged lines expand by hydrating from
  // the file-at-revision endpoint — so the out-of-hunk line appears and a fresh fetch fired for it.
  await page.evaluate(() => { (window as unknown as { __codeLoads?: string[] }).__codeLoads = []; });
  await panel(page).getByRole('button', { name: 'Full ctx' }).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __codeLoads?: string[] }).__codeLoads ?? [])).toContain('src/app.ts');

  // Plain file: the whole *current* file renders — the out-of-hunk line stays visible, but the
  // deleted old line (shown by the Hunks/Full diffs) is gone because this is the working file, not a diff
  await panel(page).getByRole('button', { name: 'Plain file' }).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  await expect(panel(page).getByText('const b = 2;')).toHaveCount(0);
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
  await page.getByRole('button', { name: 'View changes', exact: true }).click();

  // the panel opens on the Working Comparison the flyout was showing
  await expect(panel(page).getByRole('button', { name: 'Working', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // the implementation file renders; the test file stays behind the collapsed supporting group
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: /tests & docs \(1\)/iu })).toBeVisible();
});

test('deep-links a flyout file row into the panel and toggles Working / All PR', async ({ page }) => {
  await installPaneMock(page);
  const prFile = (path: string): ComparisonFile => ({ ...trackedFile(path), change: { code: 'M ', path, additions: 2, deletions: 0 } });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // an active worktree with both a Working diff and an All PR Comparison available
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/pr-only.ts', additions: 2, deletions: 0 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    // each Comparison returns a distinct file, so the header toggle is observable
    if (url.pathname === '/api/worktrees/cora/comparison') {
      const working = request.postDataJSON().kind === 'working';
      return route.fulfill({ json: working ? patchOf([trackedFile('src/app.ts')]) : { ...patchOf([prFile('src/pr-only.ts')]), kind: 'pr', base: 'origin/main', gitBase: 'origin/main' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  // the flyout defaults to All PR because a merge target exists, so it lists the PR's file
  await page.getByRole('button', { name: /^Git status:/u }).click();
  // a changed-file row deep-links the panel straight to that file's diff, in the flyout's Comparison
  await page.getByRole('button', { name: 'View changes to src/pr-only.ts' }).click();
  await expect(panel(page).getByRole('button', { name: '‹ All files' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'All PR', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(diffHeaders(page)).toHaveText([/pr-only\.ts/u]);

  // the header toggle switches the whole Comparison to Working, keeping the selected file — which
  // the Working Comparison doesn't contain, so the panel reports it is not in these changes
  await panel(page).getByRole('button', { name: 'Working', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Working', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).getByText(/isn't part of the current changes/u)).toBeVisible();

  // back to every file shows the Working Comparison's own file
  await panel(page).getByRole('button', { name: '‹ All files' }).click();
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);
});
