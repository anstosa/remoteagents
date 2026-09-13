// One tmux control-mode client per (socket, session): the console attaches once
// with `tmux -C attach-session`, follows `%output` to learn which pane changed, and
// issues its Captures as commands on the same connection so the live view needs no
// process spawn (ADR 0008). The client attaches with `ignore-size` and never declares
// a size, so it stays invisible to tmux's window-size math and the viewport
// coordinator keeps sizing the pane unchanged. This slice discards the pane bytes and
// uses `%output` only as a "this pane changed" signal; a later ticket streams them.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { SocketRef } from '../domain/models.js';
import { capturePaneArgs, paneIdPattern as paneId, safeEnv, sessionIdPattern as sessionId, tmuxBinary } from './command.js';
import { ControlProtocolParser, type CommandReply, type ControlEvent } from './control-protocol.js';

const maxCaptureDepth = 5_000;
// a command whose reply block does not arrive in this long is a broken connection: the
// client fails and its viewers reconnect, mirroring run()'s SIGKILL timeout for spawns.
// Generous because tmux orders a reply behind pending %output.
const commandTimeoutMs = 10_000;

export type PaneActivitySubscriber = {
  // a %output for the subscribed pane arrived (bytes discarded in this slice)
  onActivity: () => void;
  // tmux paused and resumed this pane; the viewer must re-capture
  onReseed: () => void;
  // the pane, session or control client ended; the viewer must reconnect
  onExit: () => void;
};

// the pane-facing surface the log socket depends on; the real client and a test fake both satisfy it
export type PaneClient = {
  subscribe(pane: string, subscriber: PaneActivitySubscriber): () => void;
  capture(pane: string, depth: number): Promise<string | undefined>;
};
export type PaneStreamProvider = {
  get(socket: SocketRef, session: string): PaneClient;
  closeAll(): void;
};

type BlockWaiter = { resolve: (reply: CommandReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class TmuxControlClient implements PaneClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser: ControlProtocolParser;
  // command replies resolve in the order commands were written (tmux serialises them)
  private readonly blockWaiters: BlockWaiter[] = [];
  private readonly subscribers = new Map<string, Set<PaneActivitySubscriber>>();
  private disposed = false;
  // resolves once the attach's own %begin/%end block has been consumed
  readonly ready: Promise<void>;

  constructor(binary: string, socketPath: string, session: string, private readonly onGone: () => void) {
    this.parser = new ControlProtocolParser(event => this.onEvent(event));
    // `-C` over pipes (never `-CC`), `-f ignore-size` so the client does not affect any
    // window's size; default stdio is 'pipe' for all three fds
    this.child = spawn(binary, ['-S', socketPath, '-C', 'attach-session', '-t', session, '-f', 'ignore-size'], { env: safeEnv() });
    this.ready = new Promise<void>((resolve, reject) => this.blockWaiters.push({ resolve: () => resolve(), reject, timer: this.armTimeout() }));
    // an attach that fails before any capture attaches a catch would otherwise be an unhandled rejection
    this.ready.catch(() => {});
    this.child.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk));
    this.child.stderr.on('data', () => { /* tmux diagnostics are not actionable here */ });
    // a write to a child whose read-end has closed (server gone) raises EPIPE
    // asynchronously; without this listener it is an unhandled 'error' that crashes the
    // whole process, and the try/catch around writes only guards synchronous throws
    this.child.stdin.on('error', () => { /* the exit handler tears the client down */ });
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
  }

  private onEvent(event: ControlEvent): void {
    switch (event.type) {
      case 'block': {
        const waiter = this.blockWaiters.shift();
        if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve({ ok: event.ok, lines: event.lines }); }
        return;
      }
      case 'output': this.notifyActivity(event.pane); return;
      // we never pause our own read, so a %pause is tmux dropping us transiently;
      // continue the pane and tell subscribers to re-capture its current state
      case 'pause': void this.continuePane(event.pane); return;
      case 'continue': return;
      case 'exit': this.fail(); return;
    }
  }

  private armTimeout(): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.fail(), commandTimeoutMs);
  }

  // send a command and await its reply block; rejects if the client is gone or stalls
  async command(text: string): Promise<CommandReply> {
    if (this.disposed) throw new Error('control client disposed');
    return await new Promise<CommandReply>((resolve, reject) => {
      this.blockWaiters.push({ resolve, reject, timer: this.armTimeout() });
      this.child.stdin.write(`${text}\n`);
    });
  }

  /**
   * Capture a pane's scrollback over the control connection and return the exact bytes
   * a spawned `capture-pane -e -p` would print, decoded as UTF-8. tmux orders this reply
   * behind any pending `%output`, so the capture reflects the pane's current screen.
   * Reply lines are byte-preserving (latin1); re-appending the terminating newline
   * reproduces the spawned stdout exactly, so the shared processing behaves identically.
   */
  async capture(pane: string, depth: number): Promise<string | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(depth) || depth < 1 || depth > maxCaptureDepth) return undefined;
    await this.ready.catch(() => undefined);
    if (this.disposed) return undefined;
    const block = await this.command(capturePaneArgs(pane, depth).join(' ')).catch(() => undefined);
    if (block === undefined || !block.ok) return undefined;
    return Buffer.from(`${block.lines.join('\n')}\n`, 'latin1').toString('utf8');
  }

  subscribe(pane: string, subscriber: PaneActivitySubscriber): () => void {
    if (!paneId.test(pane)) throw new Error('bad pane id');
    if (this.disposed) throw new Error('control client disposed');
    const set = this.subscribers.get(pane) ?? new Set<PaneActivitySubscriber>();
    set.add(subscriber);
    this.subscribers.set(pane, set);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(pane);
      // the last viewer of this session left; tear the client down
      if (this.subscriberCount() === 0) this.dispose();
    };
  }

  subscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  private notifyActivity(pane: string): void {
    const subscribers = this.subscribers.get(pane);
    if (subscribers !== undefined) for (const subscriber of [...subscribers]) subscriber.onActivity();
    // panes nobody is viewing are discarded here, never turned off
  }

  private async continuePane(pane: string): Promise<void> {
    // the pane id comes from the parser; validate before it enters a command
    if (!paneId.test(pane)) return;
    const subscribers = this.subscribers.get(pane);
    if (subscribers === undefined) return;
    try { await this.command(`refresh-client -A ${pane}:continue`); } catch { /* client gone */ }
    for (const subscriber of [...subscribers]) subscriber.onReseed();
  }

  // the control connection died unexpectedly: end every viewer, then tear down
  private fail(): void {
    if (this.disposed) return;
    const subscribers = [...this.subscribers.values()].flatMap(set => [...set]);
    this.subscribers.clear();
    this.dispose();
    for (const subscriber of subscribers) subscriber.onExit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // settle any in-flight command so its awaiting caller does not hang forever
    for (const waiter of this.blockWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('control client disposed')); }
    try { this.child.stdin.write('detach\n'); } catch { /* pipe already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    this.onGone();
  }
}

/** Lazily starts and reaps one control client per (socket, session). */
export class PaneStreamRegistry implements PaneStreamProvider {
  private readonly clients = new Map<string, TmuxControlClient>();
  private readonly binary = tmuxBinary();

  get(socket: SocketRef, session: string): TmuxControlClient {
    if (!sessionId.test(session)) throw new Error('bad session');
    const key = `${socket.fingerprint}\0${session}`;
    const existing = this.clients.get(key);
    if (existing !== undefined) return existing;
    // get() spawns immediately, and a client is reaped only once it has had a subscriber
    // that then leaves (or the client fails). The one caller (the log socket) subscribes
    // synchronously after get(), so a zero-subscriber client is never left behind.
    const client = new TmuxControlClient(this.binary, socket.path, session, () => {
      // evict a disposed client unconditionally, so a reconnecting viewer never gets it
      if (this.clients.get(key) === client) this.clients.delete(key);
    });
    this.clients.set(key, client);
    return client;
  }

  // the number of live control clients (for tests and shutdown)
  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of [...this.clients.values()]) client.dispose();
    this.clients.clear();
  }
}
