import type { SocketRef } from '../domain/models.js';
import { socketIsCurrent, tmuxBinary } from './command.js';
import { TmuxControlClient } from './control.js';

const reconnectDelayMs = 5_000;
type Connection = { fingerprint: string; client?: TmuxControlClient; connecting?: Promise<TmuxControlClient | undefined>; retryAt: number; attached?: boolean; failureReported?: boolean };

// one quiet, server-owned connection per socket; only reads may use fallback
export class TmuxCommandRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly binary = tmuxBinary();
  private closed = false;

  // undefined asks the adapter to fall back to its ordinary spawned listing
  async listPanes(socket: SocketRef, format: string): Promise<string | undefined> {
    // refuse requests after shutdown and prevent command-line injection
    if (this.closed || /[\0\r\n]/u.test(format)) return undefined;
    let entry = this.connections.get(socket.path);
    // a replaced socket has a new lifetime, including its reconnect budget
    if (entry?.fingerprint !== socket.fingerprint) {
      const previous = entry;
      entry = { fingerprint: socket.fingerprint, retryAt: 0 };
      this.connections.set(socket.path, entry);
      previous?.client?.dispose();
    }
    // failed transports retry slowly while ordinary reads continue through fallback
    if (entry.retryAt > Date.now()) return undefined;
    // concurrent readers share identity validation and the same pending attach
    if (entry.client === undefined) entry.connecting ??= this.connect(socket, entry).finally(() => { entry!.connecting = undefined; });
    const client = entry.client ?? await entry.connecting;
    // replaced sockets and shutdown never start another transport
    if (client === undefined) return undefined;
    let stage: 'attach' | 'list-panes' = 'attach';
    try {
      await client.ready;
      // only the current connection can advance its diagnostic stage
      if (entry.client === client) entry.attached = true;
      stage = 'list-panes';
      // tmux double-quoted tokens preserve literal tabs and format syntax
      const quoted = format.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$');
      const reply = await client.command(`list-panes -a -F "${quoted}"`);
      // command errors retire the transport just like disconnects
      if (!reply.ok) throw new Error('pane listing failed');
      entry.failureReported = false;
      return Buffer.from(`${reply.lines.join('\n')}${reply.lines.length === 0 ? '' : '\n'}`, 'latin1').toString('utf8');
    } catch (error) {
      this.reportFailure(socket, entry, stage, error instanceof Error ? error.message : 'unknown transport failure');
      client.dispose();
      return undefined;
    }
  }

  // one warning per degraded period avoids noise from repeated failed reconnects
  private reportFailure(socket: SocketRef, owner: Connection, stage: string, error: string): void {
    // intentional retirement and concurrent failures must stay quiet
    if (this.closed || this.connections.get(socket.path) !== owner || owner.failureReported) return;
    owner.failureReported = true;
    console.warn('[tmux dashboard] persistent connection failed; using spawned listings until reconnect', { socket: socket.path, stage, error });
  }

  // only connection creation pays for filesystem identity validation
  private async connect(socket: SocketRef, owner: Connection): Promise<TmuxControlClient | undefined> {
    // already connected reads stay free of filesystem probes
    if (owner.client !== undefined) return owner.client;
    const current = await socketIsCurrent(socket);
    // a replaced socket, removed entry or shutdown invalidates a pending reconnect
    if (!current || this.closed || this.connections.get(socket.path) !== owner) return undefined;
    owner.attached = false;
    const client = new TmuxControlClient(this.binary, socket.path, undefined, () => {
      // late exits must not evict a replacement connection
      if (this.connections.get(socket.path) !== owner || owner.client !== client) return;
      this.reportFailure(socket, owner, owner.attached ? 'connection' : 'attach', 'control client lost');
      owner.client = undefined;
      owner.retryAt = Date.now() + reconnectDelayMs;
    }, { commandOnly: true, timeoutMs: 2_000 });
    owner.client = client;
    return client;
  }

  // socket discovery bounds connection lifetime, including replaced socket paths
  retainSockets(sockets: readonly SocketRef[]): void {
    const live = new Map(sockets.map(socket => [socket.path, socket.fingerprint]));
    // retire connections absent from the current socket inventory
    for (const [path, entry] of this.connections) {
      // keep only the same socket identity
      if (live.get(path) === entry.fingerprint) continue;
      this.connections.delete(path);
      entry.client?.dispose();
    }
  }

  // shutdown never reopens a connection from a late dashboard refresh
  closeAll(): void {
    this.closed = true;
    // dispose also rejects every pending command
    for (const entry of this.connections.values()) entry.client?.dispose();
    this.connections.clear();
  }
}
