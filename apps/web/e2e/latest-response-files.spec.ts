import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushMetadata } from './pane-stream-mock.js';

test('lists and previews files from the latest assistant response above notes', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await installPaneMock(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { __copiedPath?: string }).__copiedPath = value; } } });
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the minimal console fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') {
      // omit temporary images from the completed-response file menu
      if (request.postDataJSON().message === 'Screenshots: /tmp/agent-screenshot.png') return route.fulfill({ json: { files: [] } });
      expect(request.postDataJSON()).toEqual({ message: 'Updated `apps/web/src/main.tsx:1444` and `docs/setup.md`.' });
      return route.fulfill({ json: { files: [{ path: 'apps/web/src/main.tsx', size: 1_234 }, { path: 'docs/setup.md', size: 80 }] } });
    }
    if (url.pathname === '/api/agents/agent-1/file-preview') {
      // return one host temporary image preview
      if (request.postDataJSON().path === '/tmp/agent-screenshot.png') return route.fulfill({ json: { path: '/tmp/agent-screenshot.png', size: 68, binary: true, truncated: false, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } } });
      expect(request.postDataJSON()).toEqual({ path: 'apps/web/src/main.tsx' });
      return route.fulfill({ json: { path: 'apps/web/src/main.tsx', size: 1_234, binary: false, truncated: false, content: 'export const ready = true;\nconst count = 42;\n// highlighted' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // Seed the pane so its output-link overlay scans the terminal buffer; the latest Turn
  // (for the files menu) arrives on the metadata frame.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await expect(page.getByRole('button', { name: 'Notes' })).toBeEnabled({ timeout: 15_000 });
  // The clickable file link comes from the pane text (the output-link overlay); the file
  // menu comes from the assistant message (backtick-quoted paths) via message-files.
  const emit = async (text: string, message: string) => {
    // Land the path text in the lower rows so its output-link overlay clears the
    // top-left server switcher (a click there would otherwise hit the switcher button).
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(20)}${text}\r\n`);
    await pushMetadata(page, 'agent-1', message, false);
  };
  await emit('Updated apps/web/src/main.tsx:1444 and docs/setup.md.', 'Updated `apps/web/src/main.tsx:1444` and `docs/setup.md`.');

  const filesButton = page.getByRole('button', { name: 'Files from latest response (2)' });
  const notesButton = page.getByRole('button', { name: 'Notes' });
  await expect(filesButton).toBeVisible();
  const outputPath = page.getByRole('link', { name: 'Preview apps/web/src/main.tsx' });
  await expect(outputPath).toHaveAttribute('data-output-file-path', 'apps/web/src/main.tsx');
  const outputPathBounds = await outputPath.boundingBox();
  expect(outputPathBounds).not.toBeNull();
  expect(outputPathBounds!.width).toBeGreaterThan(0);
  expect(outputPathBounds!.height).toBeGreaterThan(0);
  await outputPath.click();
  const linkedDialog = page.getByRole('dialog', { name: 'File preview: apps/web/src/main.tsx' });
  await expect(linkedDialog.getByLabel('Contents of apps/web/src/main.tsx')).toContainText('export const ready = true;');
  await linkedDialog.getByRole('button', { name: 'Close file preview' }).click();
  const [filesBounds, notesBounds] = await Promise.all([filesButton.boundingBox(), notesButton.boundingBox()]);
  expect(filesBounds!.y).toBeLessThan(notesBounds!.y);
  await filesButton.click();
  const filesMenu = page.getByLabel('Files from latest response', { exact: true });
  await expect(filesMenu).toContainText('apps/web/src/main.tsx');
  await expect(filesMenu).toContainText('docs/setup.md');

  await page.getByRole('button', { name: /apps\/web\/src\/main\.tsx/u }).click();
  const dialog = page.getByRole('dialog', { name: 'File preview: apps/web/src/main.tsx' });
  const dialogSurface = dialog.locator(':scope > div');
  const preview = dialog.getByLabel('Contents of apps/web/src/main.tsx');
  // read shared output sizing
  const outputFontSize = await page.locator(':root').evaluate(element => getComputedStyle(element).getPropertyValue('--output-font-size').trim());
  await expect(dialogSurface).toHaveCSS('width', '900px');
  await expect(dialogSurface).toHaveCSS('height', '600px');
  await expect(preview).toHaveCSS('font-size', outputFontSize);
  await expect(preview).toContainText('export const ready = true;');
  await expect(preview.locator('.syntax-line-number')).toHaveText(['1', '2', '3']);
  await expect(preview.locator('.syntax-line-number').first()).toHaveCSS('position', 'sticky');
  await expect(preview.locator('code')).toHaveAttribute('data-language', 'tsx');
  await expect(preview.locator('.syntax-keyword')).toHaveText(['export', 'const', 'const']);
  await expect(preview.locator('.syntax-keyword').first()).toHaveCSS('color', 'rgb(203, 166, 247)');
  await expect(preview.locator('.syntax-constant')).toHaveText('true');
  await expect(preview.locator('.syntax-number')).toHaveText('42');
  await expect(preview.locator('.syntax-comment')).toHaveText('// highlighted');
  const copyPath = dialog.getByRole('button', { name: 'Copy path' });
  await expect(copyPath).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(copyPath).toHaveCSS('border-top-color', 'rgb(137, 180, 250)');
  await copyPath.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedPath?: string }).__copiedPath)).toBe('apps/web/src/main.tsx');
  await dialog.getByRole('button', { name: 'Close file preview' }).click();
  await expect(dialog).toHaveCount(0);

  // preview one live host temporary screenshot
  await emit('Screenshots: /tmp/agent-screenshot.png', 'Screenshots: /tmp/agent-screenshot.png');
  await page.getByRole('link', { name: 'Preview /tmp/agent-screenshot.png' }).click();
  const imageDialog = page.getByRole('dialog', { name: 'File preview: /tmp/agent-screenshot.png' });
  const image = imageDialog.getByRole('img', { name: 'Preview of /tmp/agent-screenshot.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
