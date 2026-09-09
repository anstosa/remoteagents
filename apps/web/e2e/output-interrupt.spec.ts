import { expect, test } from '@playwright/test';

// preserve terminal control keys and local escape handling
test('output input mode forwards control keys without losing focus', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const frames: Array<{ url: string; data: string }> = [];
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open sockets and seed response metadata
      constructor(url: string | URL) {
        this.url = String(url);
        // connect on the next browser task
        window.setTimeout(() => {
          // ignore sockets closed before opening
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          // expose one previewable response file
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', text: 'Updated apps/web/src/main.tsx.', latestAssistantMessage: 'Updated `apps/web/src/main.tsx`.' }) }));
        });
      }
      send(data: string) { frames.push({ url: this.url, data }); }
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__terminalSocketFrames', { configurable: true, value: frames });
  });
  // serve console and file-preview boundaries
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: `${String((request.postDataJSON() as { kind?: unknown }).kind)}-ticket` } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // list one referenced file
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [{ path: 'apps/web/src/main.tsx', size: 1_234 }] } });
    // serve preview contents
    if (url.pathname === '/api/agents/agent-1/file-preview') return route.fulfill({ json: { path: 'apps/web/src/main.tsx', size: 1_234, binary: false, truncated: false, content: 'export const ready = true;\n' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  // decode the input socket's complete byte sequence
  const readInputKeys = async () => {
    // capture only terminal input frames
    const frames = await page.evaluate(() => {
      const captured = (window as Window & { __terminalSocketFrames: Array<{ url: string; data: string }> }).__terminalSocketFrames;
      return captured.filter(/* exclude log traffic */ frame => frame.url.includes('/ws/input/')).map(/* decode input envelopes */ frame => JSON.parse(frame.data) as { data: string });
    });
    return frames.map(/* decode terminal bytes */ frame => Buffer.from(frame.data, 'base64url').toString('utf8'));
  };

  await page.goto('/');
  await page.getByLabel('Live log').click();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  await page.keyboard.press('Control+c');

  await expect.poll(readInputKeys).toEqual(['\x03']);
  await page.waitForTimeout(100);
  expect(await readInputKeys()).toEqual(['\x03']);

  // xterm forwards escape while focused
  await page.keyboard.press('Escape');
  await expect.poll(readInputKeys).toEqual(['\x03', '\x1b']);
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  // input mode owns escape on non-editable controls
  const pageUp = page.getByRole('button', { name: 'Page up' });
  await pageUp.focus();
  await page.keyboard.press('Escape');
  await expect.poll(readInputKeys).toEqual(['\x03', '\x1b', '\x1b']);
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await expect(pageUp).toBeFocused();

  // modified escape remains local
  await page.keyboard.press('Shift+Escape');
  await page.waitForTimeout(100);
  expect(await readInputKeys()).toEqual(['\x03', '\x1b', '\x1b']);

  // input mode owns ctrl+c on non-editable controls
  await page.keyboard.press('Control+c');
  const desktopKeys = ['\x03', '\x1b', '\x1b', '\x03'];
  await expect.poll(readInputKeys).toEqual(desktopKeys);

  // flyout escape stays local
  await page.getByRole('button', { name: 'More options' }).click();
  const moreMenu = page.locator('.more-menu');
  await expect(moreMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moreMenu).toBeHidden();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  expect(await readInputKeys()).toEqual(desktopKeys);

  // active editors retain escape ownership
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Escape probe');
    document.body.append(input);
  });
  const escapeProbe = page.getByRole('textbox', { name: 'Escape probe' });
  await escapeProbe.focus();
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  await page.keyboard.press('Escape');
  await expect(escapeProbe).toBeFocused();
  expect(await readInputKeys()).toEqual(desktopKeys);
  await escapeProbe.evaluate(element => element.remove());

  // focused previews close escape locally
  const previewLink = page.getByRole('link', { name: 'Preview apps/web/src/main.tsx' });
  await previewLink.click();
  const previewDialog = page.getByRole('dialog', { name: 'File preview: apps/web/src/main.tsx' });
  await expect(previewDialog).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await readInputKeys()).toEqual(desktopKeys);
  await expect(previewDialog).toBeHidden();

  // open modals block background escape forwarding
  await previewLink.click();
  await expect(previewDialog).toBeVisible();
  await pageUp.focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await readInputKeys()).toEqual(desktopKeys);
  await previewDialog.getByRole('button', { name: 'Close file preview' }).click();

  await pageUp.click();
  const backToBottom = page.getByRole('button', { name: 'Back to bottom' });
  const pageDown = page.getByRole('button', { name: 'Page down' });
  await expect(backToBottom).toBeVisible();
  await expect(backToBottom.locator('svg')).toBeVisible();
  await expect(backToBottom).toHaveText('');
  const [backToBottomBounds, pageDownBounds] = await Promise.all([backToBottom.boundingBox(), pageDown.boundingBox()]);
  expect(backToBottomBounds!.x).toBeLessThan(pageDownBounds!.x);
  expect(backToBottomBounds!.y).toBeCloseTo(pageDownBounds!.y, 0);
  await backToBottom.click();
  await expect(backToBottom).toBeHidden();

  await page.locator('.terminal-frame.active .xterm-helper-textarea').focus();

  await page.keyboard.press('Tab');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);

  const navigationKeys = [...desktopKeys, '\t', '\x1b[Z'];
  await expect.poll(readInputKeys).toEqual(navigationKeys);

  // The mobile Ctrl latch must produce ETX from the next software-keyboard c.
  await page.setViewportSize({ width: 428, height: 900 });
  await expect(page.getByLabel('Terminal keys')).toBeVisible();
  // direct controls occupy the leftmost vertical column
  const [controlBounds, modifierBounds, arrowBounds, escBounds, ctrlCBounds] = await Promise.all([
    page.locator('.mobile-control-keys').boundingBox(),
    page.locator('.mobile-key-modifiers').boundingBox(),
    page.locator('.mobile-arrow-keys').boundingBox(),
    page.getByRole('button', { name: 'Esc', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'Ctrl+C', exact: true }).boundingBox(),
  ]);
  expect(controlBounds!.x).toBeLessThan(modifierBounds!.x);
  expect(modifierBounds!.x).toBeLessThan(arrowBounds!.x);
  expect(escBounds!.x).toBeCloseTo(ctrlCBounds!.x, 0);
  expect(escBounds!.y).toBeLessThan(ctrlCBounds!.y);
  await page.locator('.terminal-frame.active .xterm-helper-textarea').focus();
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.keyboard.press('c');
  await expect.poll(readInputKeys).toEqual([...navigationKeys, '\x03']);

  await page.getByRole('button', { name: 'Esc', exact: true }).click();
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  const allKeys = [...navigationKeys, '\x03', '\x1b', '\x03'];
  await expect.poll(readInputKeys).toEqual(allKeys);

  // inactive output ignores escape
  await page.getByLabel('Live log').click();
  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await pageUp.focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await readInputKeys()).toEqual(allKeys);

  // prompt editor ignores escape
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await readInputKeys()).toEqual(allKeys);
});
