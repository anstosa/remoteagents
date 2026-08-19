import { expect, test } from '@playwright/test';

// verify retained browser navigation
test('opens the configured project in a desktop browser split pane', async ({ page }) => {
  test.setTimeout(75_000);
  let previewLoads = 0;
  let holdNextPreviewLoad = false;
  let releasePreviewLoad: (() => void) | undefined;
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      private outputSent = false;
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // publish one output frame after viewport negotiation
      send(value: string) {
        const request: { type?: unknown } = JSON.parse(value);
        // ignore non-output sockets and later requests
        if (this.outputSent || !String(this.url).includes('/ws/logs/') || request.type !== 'viewport') return;
        this.outputSent = true;
        const text = 'Home https://project.example.com/\nLocal https://project.example.com/from-output?view=files#changed\nExternal https://outside.example.com/resource';
        window.setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text }) })));
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  // serve reported and unreported project navigation
  await page.route('https://project.example.com/**', async route => {
    previewLoads += 1;
    // hold one reload for stop coverage
    if (holdNextPreviewLoad) {
      holdNextPreviewLoad = false;
      await new Promise<void>(resolve => { releasePreviewLoad = resolve; });
    }
    const projectUrl = new URL(route.request().url());
    const location = `${projectUrl.pathname}${projectUrl.search}`;
    const links = projectUrl.pathname === '/' ? '<a href="/details?view=files#changed">View details</a><a href="/unreported">Open unreported page</a><a href="/spa">Open SPA page</a>' : '';
    const locationReport = projectUrl.pathname === '/unreported' ? '' : '<script>parent.postMessage({ type: \'rac-browser-location\', url: location.href }, \'*\')</script>';
    const spaNavigation = projectUrl.pathname === '/' ? `<script>document.querySelector('a[href="/spa"]').addEventListener('click', event => { event.preventDefault(); history.pushState({}, '', '/spa'); document.querySelector('main').dataset.location = '/spa'; parent.postMessage({ type: 'rac-browser-location', url: location.href }, '*'); });</script>` : '';
    await route.fulfill({ contentType: 'text/html', body: `<main data-location="${location}">Project preview ${previewLoads}</main>${links}${locationReport}${spaNavigation}` }).catch(() => undefined);
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], running: true, tunnel: true } }], worktrees: [{ id: 'delta', label: 'Delta', path: '/worktrees/delta', available: true, pinned: true, order: 1, projectUrl: 'https://project.example.com', stack: { actions: [], running: true, tunnel: true } }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Keep notes beside the browser.' }] } });
    if (url.pathname === '/api/worktrees/delta/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const projectControls = page.getByRole('group', { name: 'Project controls' });
  await expect(projectControls.locator('.project-open + .project-browser-toggle + .project-stack-toggle')).toHaveCount(1);
  const split = page.getByRole('button', { name: 'Open project in split view' });
  await expect(split).toBeVisible();
  const localOutputLink = page.getByRole('link', { name: 'Open https://project.example.com/from-output?view=files#changed' });
  await expect(localOutputLink).toBeVisible();
  const closedSplitPopupPromise = page.waitForEvent('popup');
  await localOutputLink.click();
  const closedSplitPopup = await closedSplitPopupPromise;
  await closedSplitPopup.close();
  await split.click();

  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('toolbar', { name: 'Browser actions' })).toContainText('Browser');
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeDisabled();

  await localOutputLink.click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/from-output?view=files');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/from-output?view=files#changed');
  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');

  const externalOutputLink = page.getByRole('link', { name: 'Open https://outside.example.com/resource' }).first();
  await expect(externalOutputLink).toHaveAttribute('href', 'https://outside.example.com/resource');
  const popupPromise = page.waitForEvent('popup');
  await externalOutputLink.click();
  const popup = await popupPromise;
  await popup.close();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');

  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Keep notes beside the browser.…' }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  const output = page.locator('.log-output');
  const noteDivider = page.getByRole('separator', { name: 'Resize agent and note panels' });
  const browserDivider = page.getByRole('separator', { name: 'Resize note and browser panels' });
  await expect(note).toBeVisible();
  await expect(noteDivider).toBeVisible();
  await expect(browserDivider).toBeVisible();
  const initialPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(initialPanels[0]!.x).toBeLessThan(initialPanels[1]!.x);
  expect(initialPanels[1]!.x).toBeLessThan(initialPanels[2]!.x);

  const dividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(dividerBounds!.x + dividerBounds!.width / 2, dividerBounds!.y + dividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBounds!.x + 90, dividerBounds!.y + dividerBounds!.height / 2);
  await page.mouse.up();
  const resizedPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(resizedPanels[0]!.width).toBeGreaterThan(initialPanels[0]!.width + 50);
  expect(resizedPanels[1]!.width).toBeLessThan(initialPanels[1]!.width - 50);
  expect(Math.abs(resizedPanels[2]!.width - initialPanels[2]!.width)).toBeLessThan(5);

  const browserDividerBounds = await browserDivider.boundingBox();
  await page.mouse.move(browserDividerBounds!.x + browserDividerBounds!.width / 2, browserDividerBounds!.y + browserDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(browserDividerBounds!.x - 70, browserDividerBounds!.y + browserDividerBounds!.height / 2);
  await page.mouse.up();
  const browserResizedPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(Math.abs(browserResizedPanels[0]!.width - resizedPanels[0]!.width)).toBeLessThan(5);
  expect(browserResizedPanels[1]!.width).toBeLessThan(resizedPanels[1]!.width - 40);
  expect(browserResizedPanels[2]!.width).toBeGreaterThan(resizedPanels[2]!.width + 40);

  const resizedNoteDividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(resizedNoteDividerBounds!.x + resizedNoteDividerBounds!.width / 2, resizedNoteDividerBounds!.y + resizedNoteDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, resizedNoteDividerBounds!.y + resizedNoteDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await output.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  const resizedBrowserDividerBounds = await browserDivider.boundingBox();
  await page.mouse.move(resizedBrowserDividerBounds!.x + resizedBrowserDividerBounds!.width / 2, resizedBrowserDividerBounds!.y + resizedBrowserDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1600, resizedBrowserDividerBounds!.y + resizedBrowserDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await browser.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  const finalNoteDividerBounds = await noteDivider.boundingBox();
  await page.mouse.move(finalNoteDividerBounds!.x + finalNoteDividerBounds!.width / 2, finalNoteDividerBounds!.y + finalNoteDividerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1600, finalNoteDividerBounds!.y + finalNoteDividerBounds!.height / 2);
  await page.mouse.up();
  expect((await note.boundingBox())!.width).toBeGreaterThanOrEqual(389);

  await preview.getByRole('link', { name: 'View details' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/details?view=files');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/details?view=files#changed');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeVisible();

  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeDisabled();
  const loadsBeforeSpaNavigation = previewLoads;
  await preview.getByRole('link', { name: 'Open SPA page' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');
  await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://project.example.com/spa');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeEnabled();
  expect(previewLoads).toBe(loadsBeforeSpaNavigation);

  await browser.getByRole('button', { name: 'Use mobile viewport' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeVisible();
  await expect(browserDivider).toBeHidden();
  await expect(noteDivider).toBeVisible();
  const [frameWidth, shellWidth, paneWidth, outputWidth, addressBounds, deviceBounds] = await Promise.all([
    browser.locator('iframe').evaluate(element => element.getBoundingClientRect().width),
    browser.locator('.browser-frame-shell').evaluate(element => element.getBoundingClientRect().width),
    browser.evaluate(element => element.getBoundingClientRect().width),
    page.locator('.log-output').evaluate(element => element.getBoundingClientRect().width),
    browser.locator('.browser-address-form').boundingBox(),
    browser.getByRole('button', { name: 'Use desktop viewport' }).boundingBox()
  ]);
  expect(frameWidth).toBeLessThanOrEqual(391);
  expect(Math.abs(frameWidth - shellWidth)).toBeLessThanOrEqual(2);
  expect(paneWidth).toBeLessThanOrEqual(391);
  expect(outputWidth).toBeGreaterThan(paneWidth);
  expect(addressBounds!.y).toBeGreaterThan(deviceBounds!.y + deviceBounds!.height);

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect(note).toBeVisible();
  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await split.click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/desktop/u);
  await browser.getByRole('button', { name: 'Close browser' }).click();

  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await split.click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await page.getByRole('tab', { name: 'Delta — Agent closed' }).click();
  await expect(browser).toHaveCount(0);
  await page.getByRole('tab', { name: 'Cora — Prompt done' }).click();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await page.reload();
  await expect(browser).toBeVisible();
  await expect(note).toBeVisible();
  await expect(browser.locator('.browser-frame-shell')).toHaveClass(/mobile/u);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');
  const restoredPanels = await Promise.all([output.boundingBox(), note.boundingBox(), browser.boundingBox()]);
  expect(restoredPanels[0]!.x).toBeLessThan(restoredPanels[1]!.x);
  expect(restoredPanels[1]!.x).toBeLessThan(restoredPanels[2]!.x);

  holdNextPreviewLoad = true;
  const loadsBeforeStop = previewLoads;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  const stopLoading = browser.getByRole('button', { name: 'Stop loading browser' });
  await expect(stopLoading).toBeVisible();
  await expect(stopLoading).toHaveClass(/loading/u);
  await expect(stopLoading).toHaveAttribute('aria-busy', 'true');
  await expect(stopLoading).toHaveCSS('animation-name', 'review-generating-glow');
  await expect(stopLoading.locator('path')).toHaveAttribute('d', 'm6 6 12 12M18 6 6 18');
  await expect.poll(() => previewLoads).toBeGreaterThan(loadsBeforeStop);
  await stopLoading.click();
  const refresh = browser.getByRole('button', { name: 'Refresh browser' });
  await expect(refresh).toBeVisible();
  await expect(refresh).not.toHaveClass(/loading/u);
  releasePreviewLoad?.();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  const loadsBeforeRefresh = previewLoads;
  await browser.getByRole('button', { name: 'Refresh browser' }).click();
  await expect.poll(() => previewLoads).toBeGreaterThan(loadsBeforeRefresh);
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/spa');

  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeDisabled();

  await preview.getByRole('link', { name: 'Open unreported page' }).click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/unreported');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeVisible();
  const homeOutputLink = page.getByRole('link', { name: 'Open https://project.example.com/', exact: true });
  await homeOutputLink.click();
  await expect(preview.locator('main')).toHaveAttribute('data-location', '/');
  await expect(browser.getByRole('button', { name: 'Go to project home' })).toBeDisabled();
  await browser.getByRole('button', { name: 'Enter browser fullscreen' }).click();
  await expect(browser).toHaveClass(/expanded/u);
  await expect(page.locator('.log-output')).toBeHidden();
  await expect(note).toBeHidden();

  await browser.getByRole('button', { name: 'Close browser' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.locator('.log-output')).toBeVisible();
  await expect(note).toBeVisible();

  await page.setViewportSize({ width: 428, height: 900 });
  await expect(split).toBeHidden();
});
