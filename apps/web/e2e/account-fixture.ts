import type { Page } from '@playwright/test';

// keep account tests connected without a live websocket backend
export async function mockAccountSocket(page: Page): Promise<void> {
  // install the inert socket before application startup
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
      // open each fixture socket asynchronously
      constructor() { window.setTimeout(() => { /* publish the connected state */ this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close each fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
}

// open the shared Codex account submenu from the persistent launcher
export async function openCodexAccounts(page: Page, navigate = true) {
  // preserve the page when checking a submenu refresh
  if (navigate) await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: /^(Choose agent|Launch agent)$/u }).click();
  const menu = page.getByRole('menu', { name: 'Choose agent', exact: true });
  await menu.getByRole('menuitem', { name: 'Codex accounts', exact: true }).click();
  return menu.getByRole('group', { name: 'Codex accounts', exact: true });
}
