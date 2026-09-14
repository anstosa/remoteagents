import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, paneInputText } from './pane-stream-mock.js';

// The streamed pane is a real terminal: focusing it marks the panel input-active and
// forwards typed control keys as pane input; when it is not focused the keys stay with
// whatever owns them (the composer, an editor, a dialog). The component spec covers the
// raw input/device-query wire; this asserts the app wiring around the pane — the
// input-active treatment, focus scoping, the file-preview link, and the mobile keys.

const routeApi = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [{ path: 'apps/web/src/main.tsx', size: 1_234 }] } });
    if (url.pathname === '/api/agents/agent-1/file-preview') return route.fulfill({ json: { path: 'apps/web/src/main.tsx', size: 1_234, binary: false, truncated: false, content: 'export const ready = true;\n' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

test('focusing the pane marks it input-active and forwards typed control keys', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Push the file mention several rows down so its Preview link clears the top-left
  // server switcher (the stream writes top-down; the old snapshot bottom-aligned).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nUpdated apps/web/src/main.tsx.\r\n');

  // Clicking the pane focuses it and marks the panel input-active (which collapses the
  // composer to the terminal helper keys on a phone).
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  // Control keys typed into the focused pane go out as input, byte for byte.
  await page.keyboard.press('Control+c');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03');
  await page.keyboard.press('Escape');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b\t');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
});

test('keys stay local when the composer or a dialog owns focus', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Push the file mention several rows down so its Preview link clears the top-left
  // server switcher (the stream writes top-down; the old snapshot bottom-aligned).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nUpdated apps/web/src/main.tsx.\r\n');

  // Focusing the composer blurs the pane; Escape there never reaches it.
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await paneInputText(page, 'agent-1')).toBe('');

  // A focused file preview closes on Escape locally, forwarding nothing to the pane.
  const previewLink = page.getByRole('link', { name: 'Preview apps/web/src/main.tsx' });
  await previewLink.click();
  const previewDialog = page.getByRole('dialog', { name: 'File preview: apps/web/src/main.tsx' });
  await expect(previewDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(previewDialog).toBeHidden();
  expect(await paneInputText(page, 'agent-1')).toBe('');
});

test('the mobile terminal keys drive the pane, including the Ctrl latch', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.setViewportSize({ width: 428, height: 900 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'ready\r\n');

  // Focus the pane so the panel is input-active and the mobile keys show.
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await expect(page.getByLabel('Terminal keys')).toBeVisible();
  // Direct controls, then modifiers, then arrows, left to right; Esc above Ctrl+C.
  const [controlBounds, modifierBounds, arrowBounds, escBounds, ctrlCBounds] = await Promise.all([
    page.locator('.mobile-control-keys').boundingBox(),
    page.locator('.mobile-key-modifiers').boundingBox(),
    page.locator('.mobile-arrow-keys').boundingBox(),
    page.getByRole('button', { name: 'Esc', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'Ctrl+C', exact: true }).boundingBox()
  ]);
  expect(controlBounds!.x).toBeLessThan(modifierBounds!.x);
  expect(modifierBounds!.x).toBeLessThan(arrowBounds!.x);
  expect(escBounds!.x).toBeCloseTo(ctrlCBounds!.x, 0);
  expect(escBounds!.y).toBeLessThan(ctrlCBounds!.y);

  // Latching Ctrl then typing c on the soft keyboard produces ETX through the modifier
  // transform; the buttons keep focus on the pane (pointerdown is prevented).
  await page.getByLabel('Live log').locator('.xterm-screen').click();
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.keyboard.press('c');
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03');

  // The Esc and Ctrl+C buttons forward their bytes directly.
  await page.getByRole('button', { name: 'Esc', exact: true }).click();
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  await expect.poll(() => paneInputText(page, 'agent-1')).toBe('\x03\x1b\x03');
});
