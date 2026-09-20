import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushMetadata, paneLastViewport } from './pane-stream-mock.js';

// provide a live output pane with optional cleanup and response-file controls
const routeApi = async (page: Page, cleanupPending = 0) => {
  // keep every request isolated from the live console
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // authenticate the browser fixture
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // include cleanup above the always-visible output controls
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, cleanupPending, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect only to the mocked pane socket
    if (path === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // keep unrelated prompt controls empty
    if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // reveal the dynamic file control after a response arrives
    if (path === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [{ path: 'apps/web/src/main.tsx', size: 1_234 }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// match the visible scroll handle to the output toolbar's edge spacing
for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
  // exercise the real xterm handle and full output controls at each breakpoint
  test(`matches scrollbar handle width to the output button margin at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    // provide enough output to create a draggable scrollback handle
    await expect.poll(() => paneLastViewport(page, 'agent-1')).toBeTruthy();
    const grid = (await paneLastViewport(page, 'agent-1'))!;
    await seedPaneSize(page, 'agent-1', grid.cols, grid.rows);
    await pushBytes(page, 'agent-1', Array.from({ length: 120 }, (_, index) => `output row ${index}\r\n`).join(''));
    const output = page.locator('.log-output');
    const handle = output.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider');
    const buttons = output.locator('.page-controls');
    await expect(handle).toBeVisible();
    await expect(buttons).toBeVisible();
    // read geometry together after terminal layout settles
    await expect.poll(async () => {
      const outputBox = await output.boundingBox();
      const handleBox = await handle.boundingBox();
      const buttonBox = await buttons.boundingBox();
      // retry until all three rendered surfaces have measurable boxes
      if (outputBox === null || handleBox === null || buttonBox === null) return false;
      const edge = outputBox.x + outputBox.width;
      const buttonMargin = edge - buttonBox.x - buttonBox.width;
      return buttonMargin > 0 && Math.abs(handleBox.width - buttonMargin) < 0.5
        && Math.abs(edge - handleBox.x - handleBox.width) < 0.5;
    }).toBe(true);
  });

  // expand only after the entire handle clears the current button stack
  test(`expands the scrollbar after clearing static and dynamic controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installPaneMock(page);
    await routeApi(page, 1);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    // fill scrollback and stabilize the mobile input layout before dragging
    await expect.poll(() => paneLastViewport(page, 'agent-1')).toBeTruthy();
    const grid = (await paneLastViewport(page, 'agent-1'))!;
    await seedPaneSize(page, 'agent-1', grid.cols, grid.rows);
    await pushBytes(page, 'agent-1', Array.from({ length: 160 }, (_, index) => `output row ${index}\r\n`).join(''));
    const output = page.locator('.log-output');
    await output.locator('.xterm-screen').click();
    const handle = output.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider');
    const track = output.locator('.xterm-scrollable-element > .scrollbar.vertical');
    const buttons = output.locator('.page-controls');
    // measure the visible width rather than an implementation class
    const width = () => handle.evaluate(element => element.getBoundingClientRect().width);
    // wait for the mobile composer resize to reach the mocked pane grid
    await expect.poll(async () => (await output.boundingBox())!.height - (await track.boundingBox())!.height).toBeLessThan(16);
    const outputBox = (await output.boundingBox())!;
    const buttonBox = (await buttons.boundingBox())!;
    const nativeWidth = (await track.boundingBox())!.width;
    const narrowWidth = outputBox.x + outputBox.width - buttonBox.x - buttonBox.width;
    expect(narrowWidth).toBeGreaterThan(0);
    expect(nativeWidth).toBeGreaterThan(narrowWidth);
    await expect.poll(width).toBeCloseTo(narrowWidth, 1);
    const handleBox = (await handle.boundingBox())!;
    const x = handleBox.x + handleBox.width / 2;
    // grab the exposed top of the thumb rather than the toolbar's near-miss area
    const y = handleBox.y + 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // leave only the bottom of the handle overlapping the topmost button
    await page.mouse.move(x, y + buttonBox.y + 10 - handleBox.y - handleBox.height, { steps: 8 });
    await expect.poll(width).toBeCloseTo(narrowWidth, 1);
    const partial = (await handle.boundingBox())!;
    expect(partial.y).toBeLessThan(buttonBox.y);
    expect(partial.y + partial.height).toBeGreaterThan(buttonBox.y);
    // move the whole handle above every currently visible control
    await page.mouse.move(x, y + buttonBox.y - 10 - handleBox.y - handleBox.height, { steps: 4 });
    await expect.poll(width).toBeCloseTo(nativeWidth, 1);
    await page.mouse.up();
    const cleared = (await handle.boundingBox())!;
    expect(cleared.y + cleared.height).toBeLessThan(buttonBox.y);

    // a newly rendered response-files button must narrow a stationary handle
    await pushMetadata(page, 'agent-1', 'Updated apps/web/src/main.tsx.');
    await expect(output.locator('.response-files-toggle')).toBeVisible();
    await expect.poll(width).toBeCloseTo(narrowWidth, 1);
    const expandedButtons = (await buttons.boundingBox())!;
    expect(cleared.y + cleared.height).toBeGreaterThan(expandedButtons.y);
    // removing the dynamic button restores the native width without another scroll
    await pushMetadata(page, 'agent-1', '');
    await expect(output.locator('.response-files-toggle')).toHaveCount(0);
    await expect.poll(width).toBeCloseTo(nativeWidth, 1);
    expect((await track.boundingBox())!.width).toBeCloseTo(nativeWidth, 1);
    const wide = (await handle.boundingBox())!;
    expect(wide.x + wide.width).toBeCloseTo(outputBox.x + outputBox.width, 1);
    // returning to the button region narrows the handle again
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect.poll(width).toBeCloseTo(narrowWidth, 1);
  });
}
