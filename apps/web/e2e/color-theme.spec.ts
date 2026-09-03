import { expect, test, type Page } from '@playwright/test';

// A console whose one agent renders a Live log, so both the terminal and the
// Global settings are on screen. `stored` seeds the localStorage key before
// the app loads, which is how the seeded-Latte case stages the persisted choice.
async function openConsole(page: Page, stored?: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(seed => {
    if (seed !== null) localStorage.setItem('rac.color-theme', seed);
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
      send() { /* frames are irrelevant to theming */ }
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
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

// The document's flavour attribute: 'latte' when set, undefined when absent (Mocha).
const themeAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

// The resolved background colour of the root element (`background: var(--crust)`),
// a real element whose paint flips with the flavour.
const rootBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

// The mobile browser-chrome colour the app advertises.
const metaThemeColor = (page: Page) => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'));

// The open terminal's painted background: xterm mirrors its theme's background
// onto the `.xterm-viewport` element's inline `background-color`, rewriting it
// whenever `options.theme` changes. Reading the on-screen (active) frame's
// viewport proves an already-open terminal repainted, using xterm's own DOM
// rather than any production-only hook.
const terminalBackground = (page: Page) => page.evaluate(() => {
  const viewport = document.querySelector<HTMLElement>('.log-canvas .terminal-frame.active .xterm-viewport');
  return viewport?.style.backgroundColor ?? '';
});

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
};

test('the toggle flips the whole UI between Dark and Light', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  // Mocha is the default: no attribute, dark crust, Mocha base advertised.
  expect(await themeAttr(page)).toBeUndefined();
  const mochaBackground = await rootBackground(page);
  expect(await metaThemeColor(page)).toBe('#1e1e2e');

  await openSettings(page);
  const dark = page.getByRole('radio', { name: 'Dark theme' });
  const light = page.getByRole('radio', { name: 'Light theme' });
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  await expect(light).toHaveAttribute('aria-checked', 'false');

  await light.click();
  // Light sets the attribute, recolours a real element live, updates the chrome,
  // and moves the checked state — with no reload.
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  await expect(light).toHaveAttribute('aria-checked', 'true');
  await expect(dark).toHaveAttribute('aria-checked', 'false');
  const latteBackground = await rootBackground(page);
  expect(latteBackground).not.toBe(mochaBackground);
  expect(await metaThemeColor(page)).toBe('#eff1f5');

  await dark.click();
  // Dark removes the attribute and returns to the Mocha default cleanly.
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBeUndefined();
  expect(await rootBackground(page)).toBe(mochaBackground);
  expect(await metaThemeColor(page)).toBe('#1e1e2e');
});

test('the choice persists across a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  await openSettings(page);
  await page.getByRole('radio', { name: 'Light theme' }).click();
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  expect(await page.evaluate(() => localStorage.getItem('rac.color-theme'))).toBe('latte');

  await page.reload();
  await expect(page.getByLabel('Live log')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  expect(await metaThemeColor(page)).toBe('#eff1f5');
});

test('a second tab of the same browser follows a storage change', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  expect(await themeAttr(page)).toBeUndefined();
  // Simulate another tab choosing Latte: the store re-reads localStorage on the
  // storage event and reflavours the document.
  await page.evaluate(() => {
    localStorage.setItem('rac.color-theme', 'latte');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.color-theme', newValue: 'latte' }));
  });
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  expect(await metaThemeColor(page)).toBe('#eff1f5');
});

test('switching back to Dark forgets the stored key', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page, 'latte');
  // A seeded Latte flavour is applied once the app mounts.
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  await openSettings(page);
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBeUndefined();
  // Mocha is the key's absence, so returning to Dark clears storage.
  expect(await page.evaluate(() => localStorage.getItem('rac.color-theme'))).toBeNull();
});

test('an already-open terminal repaints live when the flavour flips', async ({ page }) => {
  test.setTimeout(60_000);
  await openConsole(page);
  // The terminal is open and painted Mocha before any toggle.
  await expect.poll(() => terminalBackground(page), { timeout: 10_000 }).not.toBe('');
  const mochaTerminal = await terminalBackground(page);

  await openSettings(page);
  await page.getByRole('radio', { name: 'Light theme' }).click();
  // The already-open terminal follows the switch with no reload or reconnect: its
  // painted background flips to the Latte base the moment the document reflavours.
  await expect.poll(() => themeAttr(page), { timeout: 5_000 }).toBe('latte');
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).not.toBe(mochaTerminal);
  const latteTerminal = await terminalBackground(page);
  expect(latteTerminal).not.toBe('');

  await page.getByRole('radio', { name: 'Dark theme' }).click();
  // And back: switching to Dark repaints the same open terminal to Mocha again.
  await expect.poll(() => terminalBackground(page), { timeout: 5_000 }).toBe(mochaTerminal);
});

test('the pre-paint head script flavours the document before the app mounts', async ({ page }) => {
  test.setTimeout(60_000);
  // Seed the persisted Latte choice, then block the app's entry module so nothing
  // but the render-blocking /theme-init.js head script can set the attribute. If
  // Latte is present with the React app never mounted, it was applied at first
  // paint — proving the no-FOUC path.
  await page.addInitScript(() => localStorage.setItem('rac.color-theme', 'latte'));
  await page.route('**/src/main.tsx**', route => route.abort());
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe('latte');
  // The head script also flavours the mobile browser chrome, so the address bar
  // never flashes the Mocha default before the store takes over on mount.
  expect(await metaThemeColor(page)).toBe('#eff1f5');
  // Guard the isolation: the entry module was blocked, so React never mounted and
  // the flavour above can only have come from the head script — not the store.
  expect(await page.evaluate(() => document.getElementById('root')?.childElementCount)).toBe(0);
});
