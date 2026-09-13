import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
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
const agent = { id: 'agent-1', paneId: '%1', sessionId: 'sockfp:$1', socketFingerprint: 'sockfp', workspace: '/repo', title: 'Ready', kind: 'codex', attention: 'finished' };
const discovery = {
  target: async (id: string) => (id === 'agent-1' ? { agent, socket } : undefined),
  // the project proxy inspects every WS upgrade; no worktrees means it passes ours to Fastify
  worktreesNow: () => []
} as never;

// a control client whose activity the test drives, recording the session it was asked to attach
function fakePaneStream() {
  const sessions: string[] = [];
  let subscriber: PaneActivitySubscriber | undefined;
  let unsubscribes = 0;
  let text = 'first-frame';
  const client = {
    subscribe(_pane: string, sub: PaneActivitySubscriber) { subscriber = sub; return () => { unsubscribes += 1; }; },
    capture: async () => text
  };
  const provider: PaneStreamProvider = { get: (_socket, session) => { sessions.push(session); return client; }, closeAll: () => {} };
  return {
    provider,
    sessions,
    setText: (value: string) => { text = value; },
    fire: (event: keyof PaneActivitySubscriber) => subscriber?.[event](),
    unsubscribes: () => unsubscribes
  };
}

const open: Array<{ app: FastifyInstance; ws: WebSocket }> = [];
afterEach(async () => {
  for (const { app, ws } of open.splice(0)) {
    try { ws.close(); } catch { /* already closed */ }
    await app.close();
  }
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

async function connect(paneStream: PaneStreamProvider): Promise<{ frames: Record<string, unknown>[]; closeCode: () => number | undefined }> {
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery, tickets, tmux: new TmuxAdapter() as never, paneStream } as never
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
  return { frames, closeCode: () => closeCode };
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

    stream.fire('onExit');
    await waitFor(() => closeCode() !== undefined);
    expect(closeCode()).toBe(1011);
    await waitFor(() => stream.unsubscribes() >= 1);
  });
});
