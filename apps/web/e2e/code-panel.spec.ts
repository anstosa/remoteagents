import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import { codeViewOption, panelAction } from './panel-header';
import type { ComparisonFile, ComparisonFileContents, ComparisonPatch, FilePreviewView, RevisionFile } from '../src/code-panel/comparison';

// a minimal but valid git unified diff for one modified file, enough for parsePatchFiles
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
// the same diff shape with a chosen new line, so a live update can change one file's content — and
// so its content version — without changing its rendered height
const modifiedPatchTo = (path: string, line: string) => `diff --git a/${path} b/${path}\nindex 1111111..4444444 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+${line}\n const c = 4;\n`;

const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const trackedFileTo = (path: string, line: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatchTo(path, line), capped: false });
const cappedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path }, kind: 'tracked', patch: '', capped: true });

// the fingerprint tracks path *and* patch text so a live update that edits a file's content — not
// just the file set — reads as a changed Comparison, the way the server's content-sensitive one does
const patchOf = (files: ComparisonFile[], truncated = false): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => `${file.change.path}:${file.patch}`).join('|'), truncated });

// The whole file behind `modifiedPatch`, with lines past the hunk (the `sentinel` line) that only
// Plain-file and Full-context modes should surface.
const baseFile = 'const a = 1;\nconst b = 2;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const workingFile = 'const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nconst e = 6;\nconst sentinel = 999;\n';
const revision = (path: string, content: string): RevisionFile => ({ path, size: content.length, binary: false, truncated: false, content });
const contentsOf = (path: string, base: string, working: string): ComparisonFileContents => ({ path, base: revision(path, base), working: revision(path, working) });

// mount the isolated Code panel with a scripted Comparison (and optional per-file revision contents)
const mountPanel = async (page: Page, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}, startExpanded = false, rootWidth?: number) => {
  await page.goto('/');
  await page.evaluate(async ({ scripted, files, expanded, width }) => {
    const { renderCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    // stretch the panel to fill the root so its 1fr diff row is bounded and can scroll, the way the
    // real split sizes it (a bare block child would size to content and never overflow)
    root.style.display = 'grid';
    // a narrow root forces the changed-file list into its slide-over drawer (below RAIL_BREAKPOINT),
    // regardless of the viewport
    if (width !== undefined) root.style.width = `${width}px`;
    document.body.replaceChildren(root);
    renderCodePanel(root, scripted, files, expanded);
  }, { scripted: patch, files: loaded, expanded: startExpanded, width: rootWidth });
};

// push a fresh Comparison (and optional per-file contents) into the mounted panel, standing in for a
// live change-summary update from the dashboard
const updatePanel = async (page: Page, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}) => {
  await page.evaluate(async ({ scripted, files }) => {
    const { updateCodePanel } = await import('/e2e/code-panel-fixture.tsx');
    updateCodePanel(scripted, files);
  }, { scripted: patch, files: loaded });
};

// mount the REAL useCodePanel controller (with a stubbed comparison fetch) behind the panel, so a spec
// can drive its soft refresh; `page.evaluate(window.__ctrl…)` reads fetch/patch-change counts and
// pushes the next Comparison and change signal.
const mountController = async (page: Page, patch: ComparisonPatch) => {
  await page.goto('/');
  await page.evaluate(async ({ scripted }) => {
    const { renderCodeController } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    root.style.display = 'grid';
    document.body.replaceChildren(root);
    renderCodeController(root, scripted);
  }, { scripted: patch });
};
type Ctrl = { fetches: number; patchChanges: number; setNext(patch: ComparisonPatch): void; open(): void; bump(signal: string): void; openFile(path: string, content: string): void; closeFile(): void };
const controls = (page: Page) => page.evaluate(() => { const c = (window as unknown as { __ctrl: Ctrl }).__ctrl; return { fetches: c.fetches, patchChanges: c.patchChanges }; });

const panel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const diffHeaders = (page: Page) => page.locator('.code-pane diffs-container [data-title]');

// mount the panel showing a static File view (a response file or terminal link), for the render states
const mountFilePreview = async (page: Page, filePreview: FilePreviewView) => {
  await page.goto('/');
  await page.evaluate(async view => {
    const { renderFilePreview } = await import('/e2e/code-panel-fixture.tsx');
    const root = document.createElement('div');
    root.style.height = '640px';
    root.style.display = 'grid';
    document.body.replaceChildren(root);
    renderFilePreview(root, view);
  }, filePreview);
};

test('renders each File view state: text through the library, image inline, binary/error placeholders', async ({ page }) => {
  // a text file is a plain-file view rendered by the diff library (real highlighting), with a back crumb
  await mountFilePreview(page, { path: 'src/app.ts', state: 'ready', preview: { path: 'src/app.ts', size: 40, truncated: false, binary: false, content: 'export const answer = 42;\n' } });
  await expect(panel(page).getByRole('button', { name: '‹ Changes' })).toBeVisible();
  await expect(panel(page).getByText('app.ts', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('export const answer = 42;')).toBeVisible();

  // an over-cap text file keeps a truncation notice
  await mountFilePreview(page, { path: 'src/big.ts', state: 'ready', preview: { path: 'src/big.ts', size: 300_000, truncated: true, binary: false, content: 'const head = 1;\n' } });
  await expect(panel(page).getByText(/Preview limited to the first 256 KB/u)).toBeVisible();

  // an image previews inline as a plain (non-library) view
  await mountFilePreview(page, { path: 'shot.png', state: 'ready', preview: { path: 'shot.png', size: 68, truncated: false, binary: true, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } } });
  await expect(panel(page).getByRole('img', { name: 'Preview of shot.png' })).toBeVisible();

  // a non-image binary file is a placeholder, not garbage
  await mountFilePreview(page, { path: 'blob.bin', state: 'ready', preview: { path: 'blob.bin', size: 10, truncated: false, binary: true } });
  await expect(panel(page).getByText(/Binary file/u)).toBeVisible();

  // a failed preview reports it
  await mountFilePreview(page, { path: 'gone.ts', state: 'error' });
  await expect(panel(page).getByText(/Preview unavailable/u)).toBeVisible();
});

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

test('keeps the Working / All PR toggle when a Comparison resolves with no files', async ({ page }) => {
  // an empty Comparison (e.g. switching to Working when everything is committed) must not strand the
  // reviewer: the mode/layout controls hide with no files, but the Working / All PR toggle stays so
  // they can switch back to the Comparison that had changes
  await mountPanel(page, patchOf([]));

  await expect(panel(page).getByText('No changes to show.')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Working', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'All PR' })).toBeVisible();
  // the file-dependent controls are correctly absent
  await expect(panel(page).getByRole('button', { name: 'Hunks' })).toHaveCount(0);
});

test('expands a collapsed hunk gap in Hunks mode without first visiting Full context', async ({ page }) => {
  // two hunks far apart leave a large collapsed gap between them in Hunks mode
  const baseLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  const workingLines = baseLines.map((line, index) => (index === 1 ? 'line 2 changed' : index === 49 ? 'line 50 changed' : line));
  const base = `${baseLines.join('\n')}\n`;
  const working = `${workingLines.join('\n')}\n`;
  const twoHunkPatch = ['diff --git a/src/big.ts b/src/big.ts', 'index 1111111..2222222 100644', '--- a/src/big.ts', '+++ b/src/big.ts', '@@ -1,5 +1,5 @@', ' line 1', '-line 2', '+line 2 changed', ' line 3', ' line 4', ' line 5', '@@ -47,7 +47,7 @@', ' line 47', ' line 48', ' line 49', '-line 50', '+line 50 changed', ' line 51', ' line 52', ' line 53'].join('\n') + '\n';
  const bigFile: ComparisonFile = { change: { code: ' M', path: 'src/big.ts', additions: 2, deletions: 2 }, kind: 'tracked', patch: twoHunkPatch, capped: false };
  const contents: ComparisonFileContents = { path: 'src/big.ts', base: revision('src/big.ts', base), working: revision('src/big.ts', working) };
  await mountPanel(page, patchOf([bigFile]), { 'src/big.ts': contents });
  await panel(page).getByRole('button', { name: 'big.ts' }).click();

  // Hunks (default): a line inside the gap is hidden
  await expect(panel(page).getByText('line 25', { exact: true })).toHaveCount(0);
  // the gap is expandable straight away — previously it only worked after a Full-context round trip
  // hydrated the partial patch (loadDiffFiles is now provided in every mode, not just Full context)
  const gap = panel(page).locator('diffs-container').getByText(/unmodified lines/iu).first();
  await expect(gap).toBeVisible();
  await gap.click();
  await expect(panel(page).getByText('line 25', { exact: true })).toBeVisible();
});

test('keeps the view options in a fly-out, folded into the header ⋮ on a narrow panel', async ({ page }) => {
  // a narrow root (below the header's fold width) stands in for a phone / squeezed column
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/widget.ts')]), {}, false, 380);

  // the diff modes are never inline, and the narrow header folds the View options control into its ⋮
  await expect(panel(page).getByRole('button', { name: 'Hunks' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'View options' })).toHaveCount(0);
  // the Working / All PR toggle stays in the header
  await expect(panel(page).getByRole('button', { name: 'Working', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More code panel actions' }).click();
  await page.getByRole('group', { name: 'More code panel actions' }).getByRole('button', { name: 'View options' }).click();
  const flyout = panel(page).getByRole('dialog', { name: 'View options' });
  await expect(flyout.getByRole('button', { name: 'Hunks' })).toHaveAttribute('aria-pressed', 'true');
  // choosing an option applies it and closes the fly-out
  await flyout.getByRole('button', { name: 'Full ctx' }).click();
  await expect(flyout).toBeHidden();
  // reopening shows the chosen mode
  await expect(await codeViewOption(panel(page), 'Full ctx')).toHaveAttribute('aria-pressed', 'true');
});

test('Esc from the View options control closes its fly-out before it restores the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  const options = region.getByRole('button', { name: 'View options', exact: true });
  await options.click();
  const flyout = region.getByRole('dialog', { name: 'View options' });
  await expect(flyout).toBeVisible();
  await options.press('Escape');
  await expect(flyout).toBeHidden();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  // the next Escape restores
  await options.press('Escape');
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
});

test('on a desktop the view options drop from the header as a card, not a full-height drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  const options = region.getByRole('button', { name: 'View options', exact: true });
  await options.click();
  const flyout = region.getByRole('dialog', { name: 'View options' });
  await expect(flyout).toBeVisible();
  const [flyoutBox, regionBox, optionsBox] = await Promise.all([flyout.boundingBox(), region.boundingBox(), options.boundingBox()]);
  expect(flyoutBox!.height).toBeLessThan(regionBox!.height / 2);
  // it sits just beneath the header, its right edge by the button that opened it
  expect(flyoutBox!.y).toBeGreaterThanOrEqual(optionsBox!.y + optionsBox!.height);
  expect(flyoutBox!.y - (optionsBox!.y + optionsBox!.height)).toBeLessThan(40);
  expect(flyoutBox!.x + flyoutBox!.width).toBeGreaterThanOrEqual(optionsBox!.x + optionsBox!.width);
  expect(flyoutBox!.x + flyoutBox!.width).toBeLessThanOrEqual(regionBox!.x + regionBox!.width);
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
  await expect(await codeViewOption(panel(page), 'Plain file')).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Close view options' }).click();

  await panel(page).getByRole('button', { name: 'app.ts' }).click();
  await expect(panel(page).getByRole('button', { name: '‹ All files' })).toBeVisible();

  // Hunks (default): only the patched lines render, so a line past the hunk stays hidden
  await expect(diffHeaders(page)).toHaveCount(1);
  await expect(panel(page).getByText('const sentinel = 999;')).toHaveCount(0);

  // Full context: still a diff (a header renders), but the unchanged lines expand by hydrating from
  // the file-at-revision endpoint — so the out-of-hunk line appears and a fresh fetch fired for it.
  await page.evaluate(() => { (window as unknown as { __codeLoads?: string[] }).__codeLoads = []; });
  await (await codeViewOption(panel(page), 'Full ctx')).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(diffHeaders(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __codeLoads?: string[] }).__codeLoads ?? [])).toContain('src/app.ts');

  // Plain file: the whole *current* file renders — the out-of-hunk line stays visible, but the
  // deleted old line (shown by the Hunks/Full diffs) is gone because this is the working file, not a diff
  await (await codeViewOption(panel(page), 'Plain file')).click();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  await expect(panel(page).getByText('const b = 2;')).toHaveCount(0);
});

test('promotes the Code panel to full screen and restores it (control + Esc)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]));
  const region = panel(page);
  const expand = region.getByRole('button', { name: 'Expand code panel' });
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
  await expect(expand).toHaveAttribute('aria-pressed', 'false');

  // the control promotes the panel
  await expand.click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  const restore = region.getByRole('button', { name: 'Restore code panel' });
  await expect(restore).toHaveAttribute('aria-pressed', 'true');

  // Esc restores
  await restore.press('Escape');
  await expect(region).not.toHaveClass(/\bexpanded\b/u);

  // and the control restores too
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  await region.getByRole('button', { name: 'Restore code panel' }).click();
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
});

test('opens already promoted when startExpanded is set on a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), {}, true);
  const region = panel(page);
  await expect(region).toHaveClass(/\bexpanded\b/u);
  await expect(region.getByRole('button', { name: 'Restore code panel' })).toHaveAttribute('aria-pressed', 'true');
});

test('ignores startExpanded on a phone viewport, where the control offers full screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), {}, true);
  const region = panel(page);
  // the panel is not promoted (the desktop-only seed is gated off)
  await expect(region).not.toHaveClass(/\bexpanded\b/u);
  // on a phone the control hides the tab row and toolbar instead of filling the Workspace
  await expect(page.locator('.panel-header-expand')).toBeVisible();
  await expect(page.locator('.panel-header-expand')).toHaveAttribute('title', 'Full screen');
});

test('promotes the File view to full screen and restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountFilePreview(page, { path: 'src/app.ts', state: 'ready', preview: { path: 'src/app.ts', size: 40, truncated: false, binary: false, content: 'export const answer = 42;\n' } });
  const fileView = page.locator('.code-pane-file');
  await expect(fileView).not.toHaveClass(/\bexpanded\b/u);
  await panel(page).getByRole('button', { name: 'Expand code panel' }).click();
  await expect(fileView).toHaveClass(/\bexpanded\b/u);
  // Esc restores from the File view too
  await panel(page).getByRole('button', { name: 'Restore code panel' }).press('Escape');
  await expect(fileView).not.toHaveClass(/\bexpanded\b/u);
});

test('closing the changed-files drawer with Esc does not also collapse full screen', async ({ page }) => {
  // a desktop viewport (control visible) but a narrow panel (the file list is a drawer, not a rail)
  await page.setViewportSize({ width: 1200, height: 800 });
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/app.test.ts')]), {}, false, 560);
  const region = panel(page);
  await region.getByRole('button', { name: 'Expand code panel' }).click();
  await expect(region).toHaveClass(/\bexpanded\b/u);
  await region.getByRole('button', { name: 'Show changed files' }).click();
  const drawer = page.getByRole('dialog', { name: 'Changed files' });
  await expect(drawer).toBeVisible();
  // one Escape closes only the drawer; the panel stays full screen (the drawer stops the key bubbling)
  await drawer.getByRole('button', { name: 'Close changed files' }).press('Escape');
  await expect(drawer).toBeHidden();
  await expect(region).toHaveClass(/\bexpanded\b/u);
});

test('opens a Code panel of the Working changes from the Git flyout', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // one active, changed worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }, { code: ' M', path: 'src/app.test.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/code-panel', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, gitPrStatus: { base: 'origin/main', files: 1, changes: [{ code: 'M ', path: 'src/pr-only.ts', additions: 2, deletions: 0 }] }, title: 'Ready' }], projects: [] } });
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

const codeLoads = (page: Page) => page.evaluate(() => (window as unknown as { __codeLoads?: string[] }).__codeLoads ?? []);

test('refreshes a changed file in place and reuses unchanged files without rehydrating them', async ({ page }) => {
  const contents = { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile), 'src/util.ts': contentsOf('src/util.ts', baseFile, workingFile) };
  await mountPanel(page, patchOf([trackedFile('src/app.ts'), trackedFile('src/util.ts')]), contents);
  await expect(diffHeaders(page)).toHaveCount(2);

  // Full context hydrates every file from its two revisions — one loadFile per file
  await (await codeViewOption(panel(page), 'Full ctx')).click();
  await expect.poll(() => codeLoads(page)).toContain('src/app.ts');
  await expect.poll(() => codeLoads(page)).toContain('src/util.ts');
  await expect(panel(page).getByText('const sentinel = 999;').first()).toBeVisible();

  // from here watch which files re-fetch; a reused (unchanged) file must not hydrate again
  await page.evaluate(() => { (window as unknown as { __codeLoads?: string[] }).__codeLoads = []; });

  // a live update where only util.ts changed content and revisions
  const editedWorking = workingFile.replace('const b = 3;', 'const b = 9;');
  await updatePanel(page, patchOf([trackedFile('src/app.ts'), trackedFileTo('src/util.ts', 'const b = 9;')]), {
    'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile),
    'src/util.ts': contentsOf('src/util.ts', baseFile, editedWorking)
  });

  // the edited file rebuilds and shows its new content; the untouched file keeps a stable content
  // version, so the library never re-hydrates it (no fresh fetch) and its expansion survives. (Version
  // stability, not object identity, is what the library reconciles on; this pins that we hand a stable
  // version for an unchanged file and a moved one for an edit.)
  await expect(panel(page).getByText('const b = 9;')).toBeVisible();
  await expect.poll(() => codeLoads(page)).toContain('src/util.ts');
  await expect(diffHeaders(page)).toHaveCount(2);
  expect(await codeLoads(page)).not.toContain('src/app.ts');
});

// drive the real useCodePanel controller: open it (a hard load), then move its change signal (the
// production live-update trigger) and read its fetch / patch-change counts
const openController = async (page: Page) => {
  await page.waitForFunction(() => Boolean((window as unknown as { __ctrl?: Ctrl }).__ctrl));
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.open());
  await expect(diffHeaders(page).first()).toBeVisible();
};
const bumpSignal = async (page: Page, next: ComparisonPatch, signal: string) => {
  await page.evaluate(patch => (window as unknown as { __ctrl: Ctrl }).__ctrl.setNext(patch), next);
  await page.evaluate(sig => (window as unknown as { __ctrl: Ctrl }).__ctrl.bump(sig), signal);
};

test('a moved change signal soft-refreshes the open Comparison in place', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();
  const before = await controls(page);

  // the live change signal moves and the next Comparison carries new content
  await bumpSignal(page, patchOf([trackedFileTo('src/app.ts', 'const b = 9;')]), 's1');

  // the panel refetched and swapped in the new content without a mode switch or reopen
  await expect(panel(page).getByText('const b = 9;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toHaveCount(0);
  expect((await controls(page)).fetches).toBeGreaterThan(before.fetches);
});

test('an unchanged-fingerprint refresh refetches but does not repaint', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  const before = await controls(page);

  // the signal moves but the Comparison is byte-identical (a change confined to the other Comparison)
  await bumpSignal(page, patchOf([trackedFile('src/app.ts')]), 's1');

  // it did refetch, but the identical fingerprint means the patch reference is reused — no repaint
  await expect.poll(() => controls(page).then(current => current.fetches)).toBeGreaterThan(before.fetches);
  expect((await controls(page)).patchChanges).toBe(before.patchChanges);
});

test('preserves the reviewer scroll position across a soft refresh', async ({ page }) => {
  const files = Array.from({ length: 8 }, (_, index) => trackedFile(`src/mod${index}.ts`));
  await mountController(page, patchOf(files));
  await openController(page);
  await expect(panel(page).locator('.code-pane-file-row')).toHaveCount(8);

  const view = panel(page).locator('.code-pane-view');
  await view.evaluate(element => { element.scrollTop = 260; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const before = await view.evaluate(element => element.scrollTop);
  const stats = await controls(page);

  // a live edit to one file (same height) arrives via the soft refresh — which keeps the patch mounted
  // rather than blanking to a spinner, so the reviewer's place holds
  const updated = files.map((file, index) => index === 3 ? trackedFileTo('src/mod3.ts', 'const b = 9;') : file);
  await bumpSignal(page, patchOf(updated), 's1');

  // the patch actually swapped (a new fingerprint) and scroll held
  await expect.poll(() => controls(page).then(current => current.patchChanges)).toBeGreaterThan(stats.patchChanges);
  await expect.poll(() => view.evaluate((element, left) => Math.abs(element.scrollTop - left), before)).toBeLessThan(24);
});

test('keeps a full-context file expanded while its live rebuild is in flight', async ({ page }) => {
  await mountPanel(page, patchOf([trackedFile('src/app.ts')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, workingFile) });
  await panel(page).getByRole('button', { name: 'app.ts' }).click();
  await (await codeViewOption(panel(page), 'Full ctx')).click();

  // Full context expands the unchanged lines: the out-of-hunk sentinel shows, alongside the current
  // changed line (b = 3)
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 3;')).toBeVisible();

  // close the load gate so the non-partial rebuild cannot complete, then push a live edit to app.ts
  await page.evaluate(async () => { const { holdLoads } = await import('/e2e/code-panel-fixture.tsx'); holdLoads(); });
  const editedWorking = workingFile.replace('const b = 3;', 'const b = 7;');
  await updatePanel(page, patchOf([trackedFileTo('src/app.ts', 'const b = 7;')]), { 'src/app.ts': contentsOf('src/app.ts', baseFile, editedWorking) });

  // with the rebuild held, the file holds its prior expanded view — no blink back to hunks-only — so
  // the expanded sentinel stays and the new (b = 7) content has not yet replaced the old
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
  await expect(panel(page).getByText('const b = 7;')).toHaveCount(0);

  // releasing the gate swaps in the non-partial rebuild: the new content appears and the file is still
  // fully expanded, never having collapsed to hunks-only
  await page.evaluate(async () => { const { releaseLoads } = await import('/e2e/code-panel-fixture.tsx'); releaseLoads(); });
  await expect(panel(page).getByText('const b = 7;')).toBeVisible();
  await expect(panel(page).getByText('const sentinel = 999;')).toBeVisible();
});

test('opens a file in the File view through the real controller and returns to the Comparison', async ({ page }) => {
  await mountController(page, patchOf([trackedFile('src/app.ts')]));
  await openController(page);
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);

  // open a file via the real controller — a genuine openFilePreview fetch through the isFilePreview guard
  await page.evaluate(() => (window as unknown as { __ctrl: Ctrl }).__ctrl.openFile('README.md', 'hello from the file view'));
  await expect(panel(page).getByRole('button', { name: '‹ Changes' })).toBeVisible();
  await expect(panel(page).getByText('hello from the file view')).toBeVisible();
  // the File view takes over the panel: only the opened file shows, not the Comparison's app.ts diff
  await expect(diffHeaders(page)).toHaveText([/README\.md/u]);

  // leaving the File view reveals the Comparison the panel had loaded underneath (no reopen)
  await panel(page).getByRole('button', { name: '‹ Changes' }).click();
  await expect(diffHeaders(page)).toHaveText([/app\.ts/u]);
  await expect(panel(page).getByText('hello from the file view')).toHaveCount(0);
});
