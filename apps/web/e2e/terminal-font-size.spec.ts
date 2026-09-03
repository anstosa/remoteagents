import { expect, test, type Page } from '@playwright/test';

// A console whose one agent renders a Live log, so both the terminal and the
// Global settings are on screen. `stored` seeds the localStorage key before
// the app loads, which is how the garbage-value case stages a bad value.
async function openConsole(page: Page, stored?: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(seed => {
    if (seed !== null) localStorage.setItem('rac.terminal-font-size', seed);
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
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (/\/ws\/logs\/agent-1/.test(this.url)) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
            v: 1,
            type: 'reset',
            text: 'agent-1 output line\nagent-1 second line'
          }) }));
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
    // Record whether the app's capture-phase handler prevented a font shortcut's
    // default, read after the event has bubbled to the document.
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && ['=', '+', '-', '0'].includes(event.key)) {
        Object.defineProperty(window, '__fontKeyPrevented', { configurable: true, value: event.defaultPrevented });
      }
    });
  }, stored ?? null);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [
      { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }
    ], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
}

const latestViewport = (page: Page) => page.evaluate(() => {
  const frames = (window as Window & { __terminalSocketFrames?: Array<{ url: string; data: string }> }).__terminalSocketFrames ?? [];
  return frames
    .filter(frame => frame.url.includes('/ws/logs/agent-1'))
    .map(frame => JSON.parse(frame.data) as { type?: string; cols?: number; rows?: number })
    .filter(frame => frame.type === 'viewport')
    .at(-1);
});

const terminalFontPx = (page: Page) => page.evaluate(() => {
  const element = document.querySelector<HTMLElement>('.terminal-frame.active .xterm');
  return element === null ? null : getComputedStyle(element).fontSize;
});

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
};

test('the stepper enlarges the terminal, drops columns, and resets to the default', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const baseline = (await latestViewport(page))!;
  expect(await terminalFontPx(page)).toBe('11px');

  await openSettings(page);
  const larger = page.getByRole('button', { name: 'Larger terminal font' });
  const smaller = page.getByRole('button', { name: 'Smaller terminal font' });
  // Reset appears only once the size differs from the default.
  await expect(page.getByRole('button', { name: 'Reset terminal font' })).toHaveCount(0);
  await larger.click();
  await larger.click();
  await larger.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('14px');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('14px');
  await expect.poll(async () => (await latestViewport(page))?.cols ?? Infinity, { timeout: 10_000 }).toBeLessThan(baseline.cols!);

  const reset = page.getByRole('button', { name: 'Reset terminal font' });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('11px');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('11px');
  await expect(reset).toHaveCount(0);
  // Larger disables at the 24px ceiling (13 steps up from the 11px default).
  for (let step = 0; step < 13; step += 1) await larger.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('24px');
  await expect(larger).toBeDisabled();
  await reset.click();
  // Smaller disables at the 8px floor (3 steps down from the default).
  for (let step = 0; step < 3; step += 1) await smaller.click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('8px');
  await expect(smaller).toBeDisabled();
});

test('the keyboard shortcut resizes the terminal and prevents page zoom', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const baseline = (await latestViewport(page))!;

  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('13px');
  await expect.poll(async () => (await latestViewport(page))?.cols ?? Infinity, { timeout: 10_000 }).toBeLessThan(baseline.cols!);
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(true);

  await page.keyboard.press('Control+Minus');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('12px');
  await page.keyboard.press('Control+Digit0');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('11px');
  // Reset forgets the stored key so the default tracks the CSS variable.
  expect(await page.evaluate(() => localStorage.getItem('rac.terminal-font-size'))).toBeNull();
});

test('the shortcut resizes while the terminal pane is focused', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  // xterm holds keyboard focus in a hidden textarea; the shortcut must still
  // resize the pane rather than being mistaken for an editable field.
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.terminal-frame.active .xterm-helper-textarea')?.focus());
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('12px');
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(true);
});

test('the shortcut clamps at the 8px floor and 24px ceiling', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  for (let step = 0; step < 15; step += 1) await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('24px');
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('Control+Minus');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('8px');
});

test('a second tab of the same browser follows a storage change', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  // Simulate another tab writing the key: the store re-reads localStorage on the
  // storage event and re-renders the terminal at the new size.
  await page.evaluate(() => {
    localStorage.setItem('rac.terminal-font-size', '16');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.terminal-font-size', newValue: '16' }));
  });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('16px');
});

test('the size survives a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await page.keyboard.press('Control+Equal');
  await expect.poll(async () => await terminalFontPx(page), { timeout: 5_000 }).toBe('14px');
  expect(await page.evaluate(() => localStorage.getItem('rac.terminal-font-size'))).toBe('14');

  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 10_000 }).toBe('14px');
});

test('the prompt composer ignores the shortcut', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await expect.poll(() => latestViewport(page), { timeout: 15_000 }).toBeTruthy();
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await composer.click();
  await expect(composer).toBeFocused();

  await page.keyboard.press('Control+Equal');
  // The console leaves the shortcut to the browser while an editable field owns
  // the keys: the font is unchanged and its default was not prevented.
  await expect(page.getByLabel('Live log')).toBeVisible();
  expect(await terminalFontPx(page)).toBe('11px');
  expect(await page.evaluate(() => (window as Window & { __fontKeyPrevented?: boolean }).__fontKeyPrevented)).toBe(false);
});

test('a garbage stored value falls back to the default', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page, 'not-a-number');
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => await terminalFontPx(page), { timeout: 10_000 }).toBe('11px');
  await openSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('11px');
});
