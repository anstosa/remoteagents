import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { codexAdapter } from '../src/adapters/codex.js';
import type { PaneActivitySubscriber, PaneStreamProvider } from '../src/tmux/control.js';
import { testConfig, testProject } from './helpers/config.js';

// Drive the real /ws/logs handler over a real WebSocket, with a fake pane stream so no
// tmux is spawned. This is the seam that catches the log-socket wiring: which session
// the control client attaches to, the event-driven frame, and teardown — none of which
// the class-level control tests (host-only) or the framer tests can see. Node's global
// WebSocket has no header control, so the app's public origin is pointed at the loopback
// address it actually listens on to satisfy the same-host check.

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true, active: () => true } as never;
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const socket = { fingerprint: 'sockfp', path: '/tmp/rac-logs-test.sock', device: 0, inode: 0 };
// the composite agent id embeds the raw tmux session ($1) behind the socket fingerprint
const agentOf = (kind: string) => ({ id: 'agent-1', paneId: '%1', sessionId: 'sockfp:$1', socketFingerprint: 'sockfp', workspace: '/repo', title: 'Ready', kind, attention: 'finished' });
const discoveryOf = (kind: string) => ({
  target: async (id: string) => (id === 'agent-1' ? { agent: agentOf(kind), socket } : undefined),
  // the project proxy inspects every WS upgrade; no worktrees means it passes ours to Fastify
  worktreesNow: () => []
}) as never;

// a control client whose activity the test drives, recording the session it was asked to
// attach and the depths it was asked to capture (so a derive Capture is observable)
function fakePaneStream() {
  const sessions: string[] = [];
  const captureDepths: number[] = [];
  let subscriber: PaneActivitySubscriber | undefined;
  let unsubscribes = 0;
  let text = 'first-frame';
  const client = {
    subscribe(_pane: string, sub: PaneActivitySubscriber) { subscriber = sub; return () => { unsubscribes += 1; }; },
    capture: async (_pane: string, depth: number) => { captureDepths.push(depth); return text; },
    windowId: async () => '@7',
    sendInput: async () => true,
    seed: async () => Buffer.alloc(0)
  };
  const provider: PaneStreamProvider = { get: (_socket, session) => { sessions.push(session); return client; }, openPaneKeys: () => new Set(), closeAll: () => {} };
  return {
    provider,
    sessions,
    captureDepths,
    setText: (value: string) => { text = value; },
    fire: (event: 'onActivity' | 'onReseed' | 'onResize') => subscriber?.[event]?.(),
    exit: (reason = 'session ended') => subscriber?.onExit?.(reason),
    unsubscribes: () => unsubscribes
  };
}

const open: Array<{ app: FastifyInstance; ws: WebSocket }> = [];
afterEach(async () => {
  const closed = new Set<FastifyInstance>();
  for (const { app, ws } of open.splice(0)) {
    try { ws.close(); } catch { /* already closed */ }
    // a test may register two sockets on one app; close each app once
    if (!closed.has(app)) { closed.add(app); await app.close().catch(() => { /* already closed */ }); }
  }
  vi.restoreAllMocks();
});

// a loopback port to point the app's public origin at, so the browserless WebSocket's
// automatic Host header matches the same-host check
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function connect(paneStream: PaneStreamProvider, kind = 'codex'): Promise<{ frames: Record<string, unknown>[]; send: (frame: unknown) => void; closeCode: () => number | undefined }> {
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery: discoveryOf(kind), tickets, tmux: new TmuxAdapter() as never, paneStream } as never
  );
  await app.listen({ host: '127.0.0.1', port });
  const ticket = tickets.mint('session', 'logs', 'agent-1').id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/logs/agent-1`, ['rac', ticket]);
  open.push({ app, ws });
  const frames: Record<string, unknown>[] = [];
  let closeCode: number | undefined;
  ws.addEventListener('message', event => frames.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>));
  ws.addEventListener('close', event => { closeCode = (event as CloseEvent).code; });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('websocket failed to open')));
  });
  return { frames, send: (frame: unknown) => ws.send(JSON.stringify(frame)), closeCode: () => closeCode };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('log socket did not reach the expected state');
}

describe('/ws/logs event-driven frames', () => {
  it('attaches the control client to the raw tmux session, not the composite agent id', async () => {
    const stream = fakePaneStream();
    await connect(stream.provider);
    await waitFor(() => stream.sessions.length > 0);
    expect(stream.sessions).toEqual(['$1']);
  });

  it('sends an initial frame, stays quiet while idle, and frames a %output within the quiet window', async () => {
    const stream = fakePaneStream();
    const { frames } = await connect(stream.provider);

    // the initial capture (over the fake connection) produces one frame
    await waitFor(() => frames.length >= 1);
    expect(String(frames[0]!.text)).toContain('first-frame');

    // an idle pane is never captured, so no further frame arrives on the interval
    const afterInitial = frames.length;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(frames.length).toBe(afterInitial);

    // a %output arms the quiet window; one changed capture then frames
    stream.setText('second-frame');
    stream.fire('onActivity');
    await waitFor(() => frames.some(frame => String(frame.text).includes('second-frame')));
  });

  it('re-captures the pane when the control client reseeds after a pause', async () => {
    const stream = fakePaneStream();
    const { frames } = await connect(stream.provider);
    await waitFor(() => frames.length >= 1);

    // tmux paused then resumed the pane; the viewer re-captures its current screen
    stream.setText('after-reseed');
    stream.fire('onReseed');
    await waitFor(() => frames.some(frame => String(frame.text).includes('after-reseed')));
  });

  it('closes the socket when the control client exits and unsubscribes on close', async () => {
    const stream = fakePaneStream();
    const { frames, closeCode } = await connect(stream.provider);
    await waitFor(() => frames.length >= 1);

    stream.exit();
    await waitFor(() => closeCode() !== undefined);
    expect(closeCode()).toBe(1011);
    await waitFor(() => stream.unsubscribes() >= 1);
  });
});

describe('/ws/logs derive', () => {
  const question = { id: 'q', text: 'Pick one', choices: ['1. keep', '2. drop'], source: 'parsed' as const };

  it('frames a derived question after the quiet window and never re-parses an unchanged pane', async () => {
    // the real Codex parser is replaced by a counting one: a question only when the pane
    // text carries the marker, so the test controls both the question and the parse count
    const questions = codexAdapter.questions as { parse: (capture: string) => typeof question | undefined };
    const parse = vi.spyOn(questions, 'parse').mockImplementation(capture => capture.includes('CHOOSE') ? question : undefined);
    const stream = fakePaneStream();
    const { frames } = await connect(stream.provider);
    await waitFor(() => frames.length >= 1);

    // the pane prints a Codex-shaped choice list; the next frame carries the question
    stream.setText('CHOOSE an option');
    stream.fire('onActivity');
    await waitFor(() => frames.some(frame => JSON.stringify(frame.question) === JSON.stringify(question)));

    // an idle re-capture of the same pane must not run the parser again
    const parsesAfterQuestion = parse.mock.calls.length;
    const framesAfterQuestion = frames.length;
    stream.fire('onActivity');
    stream.fire('onActivity');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(parse.mock.calls.length).toBe(parsesAfterQuestion);
    expect(frames.length).toBe(framesAfterQuestion);
  });

  it('sends Turn metadata on the derive frame and answers an on-demand metadata request', async () => {
    const stream = fakePaneStream();
    const { frames, send } = await connect(stream.provider);

    // the derive frame at subscribe carries the latest Turn's metadata envelope
    await waitFor(() => frames.some(frame => (frame.metadata as { state?: string } | undefined)?.state === 'complete'));

    // an on-demand request answers even though the pane text did not change
    const before = frames.length;
    send({ v: 1, type: 'metadata' });
    await waitFor(() => frames.length > before);
    expect((frames.at(-1)!.metadata as { state?: string }).state).toBe('complete');
  });

  it('performs no deep derive Capture for a Claude Agent', async () => {
    const stream = fakePaneStream();
    const { frames, send } = await connect(stream.provider, 'claude');
    await waitFor(() => frames.length >= 1);

    // Claude has no Turns and no question parser, so it takes only the cheap window Capture
    // (never the 5000-line derive) and its frames carry no question or metadata
    stream.setText('claude output');
    stream.fire('onActivity');
    await waitFor(() => frames.some(frame => String(frame.text).includes('claude output')));
    // an on-demand metadata request is a no-op for a non-derive Adapter: no frame at all,
    // not even a forced empty reset
    const beforeRequest = frames.length;
    send({ v: 1, type: 'metadata' });
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(frames.length).toBe(beforeRequest);
    expect(stream.captureDepths.length).toBeGreaterThan(0);
    expect(stream.captureDepths).not.toContain(5_000);
    expect(frames.every(frame => frame.metadata === undefined && frame.question === undefined)).toBe(true);
  });
});

describe('/ws/logs window-keyed Size claim', () => {
  it('shares one claim between two panes of the same window (keyed by window, not pane)', async () => {
    // Both panes resolve to window @7 (the fake pane stream's windowId). The claim is keyed by
    // window, so the two viewers share one coordinator entry and release unpins exactly once.
    // Were the claim keyed by pane id, each socket would hold its own claim and unpin twice —
    // this is what proves app.ts uses the resolved window id in the key, not the pane fallback.
    const resizes: Array<{ pane: string; cols: number; rows: number }> = [];
    const unpins: string[] = [];
    type Capture = (depth: number) => Promise<string | undefined>;
    const tmux = {
      size: async () => ({ cols: 80, rows: 24 }),
      resize: async (_s: unknown, pane: string, cols: number, rows: number) => { resizes.push({ pane, cols, rows }); return true; },
      unpinWindowSize: async (_s: unknown, pane: string) => { unpins.push(pane); return true; },
      captureRecentWindow: async (_s: unknown, _p: string, _r: number, via: Capture) => { const text = await via(60); return text === undefined ? undefined : { text, older: false }; },
      captureWindow: async (_s: unknown, _p: string, _h: number, _r: number, via: Capture) => { const text = await via(5_000); return text === undefined ? undefined : { text, older: false }; }
    } as never;
    const panes: Record<string, string> = { 'agent-1': '%1', 'agent-2': '%2' };
    const discovery = {
      target: async (id: string) => (panes[id] ? { agent: { ...agentOf('claude'), id, paneId: panes[id] }, socket } : undefined),
      worktreesNow: () => []
    } as never;
    const stream = fakePaneStream();

    const port = await freePort();
    const tickets = new TicketStore();
    const app = await buildApp(
      testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
      { auth, control, dashboardUpdates, discovery, tickets, tmux, paneStream: stream.provider } as never
    );
    await app.listen({ host: '127.0.0.1', port });

    const openViewport = async (id: string, cols: number, rows: number) => {
      const ticket = tickets.mint('session', 'logs', id).id;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/logs/${id}`, ['rac', ticket]);
      open.push({ app, ws });
      await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('websocket failed to open'))); });
      ws.send(JSON.stringify({ v: 1, type: 'viewport', cols, rows }));
      return ws;
    };

    const first = await openViewport('agent-1', 100, 30);
    await waitFor(() => resizes.some(resize => resize.pane === '%1'));
    const second = await openViewport('agent-2', 120, 40);
    await waitFor(() => resizes.some(resize => resize.pane === '%2'));

    first.close();
    second.close();
    await waitFor(() => unpins.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // one window, one claim: exactly one unpin, for the window's single (latest) owner
    expect(unpins).toEqual(['%2']);
  });
});
