import type { Page } from '@playwright/test';

// The shared binary-capable mock WebSocket for the streamed Agent panel. Every app-level
// spec that drives the panel installs this in place of its own private mock: it overrides
// `window.WebSocket` so the panel's `/ws/pane/:id` connection is scripted, delivers raw
// pane bytes as `arraybuffer` binary frames and JSON server frames as text, and captures
// the JSON frames the panel sends back. The spec drives it through `window.__pane`, which
// the helpers below wrap with a typed, `page`-bound API.
//
// It is a self-contained function so Playwright can serialise it into an init script (it
// closes over no module scope); the app opens the pane socket only after minting a `pane`
// ticket, so each spec must also fulfil `POST /api/agents/:id/tickets` with `{ ticket }`.

export function installPaneStreamMock(): void {
  const paneSockets = new Map<string, MockPaneSocket[]>();
  const connectCounts = new Map<string, number>();
  // Frames the panel has sent for an id, across every socket it opened (so a remount
  // reopening the pane keeps accumulating rather than resetting).
  const sentByPane = new Map<string, string[]>();

  class MockPaneSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly sent: string[] = [];
    readonly paneId: string | undefined;

    constructor(url: string | URL) {
      this.url = String(url);
      // A Terminal socket names its pane with `?pane=%N` (the Worktree-keyed form), so key by
      // that pane id when present — distinct terminals of one Worktree get distinct mocks. The
      // Agent panel sends no `pane`, so it keys by the target id in the path as before.
      const paneQuery = /[?&]pane=([^&]+)/u.exec(this.url);
      const match = /\/ws\/pane\/([^/?]+)/u.exec(this.url);
      this.paneId = paneQuery ? decodeURIComponent(paneQuery[1]!) : match ? decodeURIComponent(match[1]!) : undefined;
      if (this.paneId !== undefined) {
        const list = paneSockets.get(this.paneId) ?? [];
        list.push(this);
        paneSockets.set(this.paneId, list);
        connectCounts.set(this.paneId, (connectCounts.get(this.paneId) ?? 0) + 1);
      }
      // Open on the next browser task, as a real socket would.
      window.setTimeout(() => {
        if (this.readyState !== MockPaneSocket.CONNECTING) return;
        this.readyState = MockPaneSocket.OPEN;
        this.onopen?.(new Event('open'));
      });
    }

    private forget() {
      if (this.paneId === undefined) return;
      const list = paneSockets.get(this.paneId);
      const index = list?.indexOf(this) ?? -1;
      if (list && index >= 0) list.splice(index, 1);
    }

    send(data: string) {
      this.sent.push(data);
      if (this.paneId !== undefined) {
        const log = sentByPane.get(this.paneId) ?? [];
        log.push(data);
        sentByPane.set(this.paneId, log);
      }
      // A single-client server arbitrates the pane to the browser's requested grid, so
      // echo every `viewport` back as a `size`. This keeps the terminal conforming to the
      // panel as it resizes (a split view opening, the font changing), like the console.
      try {
        const frame = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
        if (frame.type === 'viewport' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
          const { cols, rows } = frame;
          window.setTimeout(() => {
            if (this.readyState === MockPaneSocket.OPEN) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'size', cols, rows }) }));
          });
        }
      } catch { /* not a JSON frame */ }
    }

    close() {
      if (this.readyState === MockPaneSocket.CLOSED) return;
      this.readyState = MockPaneSocket.CLOSED;
      this.forget();
      this.onclose?.(new CloseEvent('close'));
    }

    // Test-only: drop the connection as a lost socket would, with a code and reason.
    drop(code: number, reason: string) {
      if (this.readyState === MockPaneSocket.CLOSED) return;
      this.readyState = MockPaneSocket.CLOSED;
      this.forget();
      this.onclose?.(new CloseEvent('close', { code, reason }));
    }
  }

  Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockPaneSocket });

  const live = (id: string): MockPaneSocket | undefined => {
    const list = paneSockets.get(id);
    return list !== undefined && list.length > 0 ? list[list.length - 1] : undefined;
  };
  const deliver = (id: string, data: string | ArrayBuffer) => {
    const socket = live(id);
    if (socket === undefined || socket.readyState !== MockPaneSocket.OPEN) return;
    socket.onmessage?.(new MessageEvent('message', { data }));
  };
  const deliverBytes = (id: string, bytes: Uint8Array) => deliver(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const deliverFrame = (id: string, frame: unknown) => deliver(id, JSON.stringify(frame));
  const decodeInput = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0)));
  const parsedSent = (id: string) => (sentByPane.get(id) ?? []).map(raw => JSON.parse(raw) as Record<string, unknown>);
  const inputFrames = (id: string) => parsedSent(id).filter(frame => frame.type === 'input');

  Object.defineProperty(window, '__pane', {
    configurable: true,
    value: {
      // Agent ids with an open pane socket right now.
      openIds: () => [...paneSockets.entries()].filter(([, list]) => list.some(socket => socket.readyState === MockPaneSocket.OPEN)).map(([id]) => id),
      ready: (id: string) => live(id)?.readyState === MockPaneSocket.OPEN,
      // Sockets ever opened for this id (grows on reconnect).
      connectCount: (id: string) => connectCounts.get(id) ?? 0,
      // Server → browser.
      size: (id: string, cols: number, rows: number) => deliverFrame(id, { type: 'size', cols, rows }),
      bytes: (id: string, text: string) => deliverBytes(id, new TextEncoder().encode(text)),
      frame: (id: string, frame: unknown) => deliverFrame(id, frame),
      question: (id: string, question: unknown) => deliverFrame(id, { type: 'question', question }),
      metadata: (id: string, message: string, overflow: boolean) => deliverFrame(id, { type: 'metadata', metadata: { message, overflow } }),
      reseed: (id: string) => deliverFrame(id, { type: 'reseed' }),
      exit: (id: string, reason: string) => deliverFrame(id, { type: 'exit', reason }),
      drop: (id: string, code: number, reason: string) => live(id)?.drop(code, reason),
      // Browser → server (what the panel sent).
      frameTypes: (id: string) => parsedSent(id).map(frame => frame.type as string),
      lastViewport: (id: string) => parsedSent(id).filter(frame => frame.type === 'viewport').at(-1),
      inputText: (id: string) => inputFrames(id).map(frame => decodeInput(String(frame.data))).join(''),
      inputList: (id: string) => inputFrames(id).map(frame => decodeInput(String(frame.data))),
      inputCount: (id: string) => inputFrames(id).length,
      ackTotal: (id: string) => parsedSent(id).filter(frame => frame.type === 'ack').reduce((sum, frame) => sum + Number(frame.bytes), 0)
    }
  });
}

// --- Typed, page-bound accessors for specs -------------------------------------------

interface PaneApi {
  openIds: () => string[];
  ready: (id: string) => boolean;
  connectCount: (id: string) => number;
  size: (id: string, cols: number, rows: number) => void;
  bytes: (id: string, text: string) => void;
  frame: (id: string, frame: unknown) => void;
  question: (id: string, question: unknown) => void;
  metadata: (id: string, message: string, overflow: boolean) => void;
  reseed: (id: string) => void;
  exit: (id: string, reason: string) => void;
  drop: (id: string, code: number, reason: string) => void;
  frameTypes: (id: string) => string[];
  lastViewport: (id: string) => { cols: number; rows: number; scrollback: number } | undefined;
  inputText: (id: string) => string;
  inputList: (id: string) => string[];
  inputCount: (id: string) => number;
  ackTotal: (id: string) => number;
}

// `page.evaluate` callbacks run in the browser, so each reaches `window.__pane` directly
// rather than through a Node-side helper (a free variable would not serialise).
type PaneWindow = { __pane: PaneApi };

// Install the mock before the app loads. Call once per test, before `page.goto`.
export const installPaneMock = (page: Page) => page.addInitScript(installPaneStreamMock);

// Wait until the panel has opened a pane socket for `id`, then push the first size so the
// seed can be applied at the browser's grid.
export const seedPaneSize = async (page: Page, id: string, cols = 80, rows = 24) => {
  await page.waitForFunction(paneId => (window as unknown as PaneWindow).__pane.ready(paneId), id);
  await page.evaluate(({ id, cols, rows }) => (window as unknown as PaneWindow).__pane.size(id, cols, rows), { id, cols, rows });
};

export const pushBytes = (page: Page, id: string, text: string) => page.evaluate(({ id, text }) => (window as unknown as PaneWindow).__pane.bytes(id, text), { id, text });
export const pushQuestion = (page: Page, id: string, question: unknown) => page.evaluate(({ id, question }) => (window as unknown as PaneWindow).__pane.question(id, question), { id, question });
export const pushMetadata = (page: Page, id: string, message: string, overflow = false) => page.evaluate(({ id, message, overflow }) => (window as unknown as PaneWindow).__pane.metadata(id, message, overflow), { id, message, overflow });
export const pushExit = (page: Page, id: string, reason: string) => page.evaluate(({ id, reason }) => (window as unknown as PaneWindow).__pane.exit(id, reason), { id, reason });
export const dropPane = (page: Page, id: string, code = 1006, reason = 'lost') => page.evaluate(({ id, code, reason }) => (window as unknown as PaneWindow).__pane.drop(id, code, reason), { id, code, reason });
export const paneConnectCount = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.connectCount(id), id);
export const paneInputText = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputText(id), id);
export const paneInputList = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputList(id), id);
export const paneInputCount = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputCount(id), id);
export const paneFrameTypes = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.frameTypes(id), id);
export const paneLastViewport = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.lastViewport(id), id);
export const paneAckTotal = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.ackTotal(id), id);
