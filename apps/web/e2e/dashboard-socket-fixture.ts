import type { Page } from '@playwright/test';

// install one controllable dashboard channel without opening real sockets
export async function installDashboardSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let dashboardSocket: MockWebSocket | undefined;
    // retain the browser socket lifecycle used by dashboard and pane clients
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly OPEN = 1;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // capture dashboard connections and asynchronously open live sockets
      constructor(url: string | URL) {
        this.url = String(url);
        // keep pane sockets independent from dashboard pushes
        if (this.url.includes('/ws/dashboard')) dashboardSocket = this;
        window.setTimeout(() => {
          // do not reopen a socket closed during setup
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }
      // accept client frames without external traffic
      send() {}
      // deliver one close notification
      close() {
        // ignore repeated teardown
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    // deliver snapshots through the public websocket message boundary
    Object.defineProperty(window, '__emitDashboard', { configurable: true, value: (dashboard: unknown) => dashboardSocket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'dashboard', dashboard }) })) });
    // expose readiness before tests send a snapshot
    Object.defineProperty(window, '__dashboardSocketReady', { configurable: true, value: () => dashboardSocket?.readyState === MockWebSocket.OPEN && dashboardSocket.onmessage !== null });
  });
}

// report when the controlled dashboard channel can receive snapshots
export const dashboardSocketReady = (page: Page): Promise<boolean> => page.evaluate(() => (window as typeof window & { __dashboardSocketReady: () => boolean }).__dashboardSocketReady());

// send one test snapshot through the controlled dashboard channel
export const emitDashboard = (page: Page, dashboard: unknown): Promise<void> => page.evaluate(next => (window as typeof window & { __emitDashboard: (dashboard: unknown) => void }).__emitDashboard(next), dashboard);
