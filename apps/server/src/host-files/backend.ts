import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';
import type {
  HostFilesBackend,
  HostFilesCommand,
  HostFilesCommandResult,
  HostFilesErrorCode,
  HostFilesReadCommand,
  HostFilesWriteCommand,
  HostFilesWriteResult
} from './contracts.js';
import { HostFilesError } from './contracts.js';
import {
  BrokerFrameKind,
  HOST_FILES_PROTOCOL,
  HostFilesTransportError,
  decodeBrokerFrames,
  decodeControlPayload,
  isRecord,
  writeBinaryFrames,
  writeControlFrame
} from './protocol.js';

export type BrokerConnectionIdentity = {
  socketPath: string;
  namespaceRoot?: string;
  socketHostPath?: string;
  generation: string;
  capability: string;
};

export type BrokerIdentityValidator = () => Promise<BrokerConnectionIdentity>;

// map a broker error envelope to stable service errors
function brokerError(value: unknown): Error {
  // hide malformed broker details behind the transport boundary
  if (!isRecord(value) || value.type !== 'error' || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return new HostFilesTransportError('protocol_error', 'invalid broker error');
  }
  const statuses = {
    invalid_path: 400,
    permission_denied: 403,
    not_found: 404,
    stale_object: 409,
    favorite_replaced: 409,
    favorite_freshness_pending: 409,
    conflict: 409,
    unsupported_type: 422,
    unsupported_cross_filesystem_rename: 422,
    unsupported_relocation: 422,
    limit_exceeded: 413,
    busy: 429,
    broker_busy: 503,
    bridge_unavailable: 503,
    partial_failure: 500,
    invalid_request: 400
  } satisfies Readonly<Record<HostFilesErrorCode, number>>;
  // preserve known engine codes and collapse unknown failures
  if (value.code in statuses) {
    const code = value.code as HostFilesErrorCode;
    return new HostFilesError(code, value.message, statuses[code], code === 'broker_busy');
  }
  return new HostFilesTransportError('bridge_unavailable', 'host files broker failed');
}

// connect one private Unix socket without path interpolation
async function connectSocket(identity: BrokerConnectionIdentity): Promise<Socket> {
  // translate socket errors to one fail-closed service state
  try {
    let socket: Socket;
    // shorten proc-root socket names below sockaddr_un's fixed path bound
    if (identity.namespaceRoot !== undefined && identity.socketHostPath !== undefined) {
      const previousDirectory = process.cwd();
      // process.chdir and net.connect dispatch synchronously without JS interleaving
      try {
        process.chdir(identity.namespaceRoot);
        socket = connect({ path: identity.socketHostPath.slice(1) });
      } finally {
        process.chdir(previousDirectory);
      }
    } else {
      socket = connect({ path: identity.socketPath });
    }
    await new Promise<void>((resolve, reject) => {
      // remove the losing connection listener
      const cleanup = () => {
        socket.removeListener('connect', connected);
        socket.removeListener('error', failed);
      };
      // accept the connected socket
      const connected = () => { cleanup(); resolve(); };
      // reject connection establishment errors
      const failed = (error: Error) => { cleanup(); reject(error); };
      socket.once('connect', connected);
      socket.once('error', failed);
    });
    return socket;
  } catch (error) {
    throw new HostFilesTransportError('bridge_unavailable', 'host files broker is unavailable', error);
  }
}

// bind cancellation to the actual operation connection
function bindAbort(socket: Socket, signal: AbortSignal | undefined): () => void {
  // skip listener allocation without a signal
  if (signal === undefined) return () => {};
  // send cancel before closing the transport
  const abort = () => {
    void writeControlFrame(socket, { type: 'cancel' })
      .catch(() => {})
      .finally(() => socket.destroy());
  };
  // handle cancellation before connection use
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

// require one control payload from an async frame iterator
async function nextControl(iterator: AsyncIterator<{ kind: BrokerFrameKind; payload: Buffer }>): Promise<unknown> {
  const next = await iterator.next();
  // treat EOF as backend loss
  if (next.done) throw new HostFilesTransportError('bridge_unavailable', 'host files broker disconnected');
  // keep binary bytes out of control positions
  if (next.value.kind !== BrokerFrameKind.Control) throw new HostFilesTransportError('protocol_error', 'unexpected broker binary frame');
  return decodeControlPayload(next.value.payload);
}

// require the broker's authentication acknowledgement
async function authenticateOperation(
  socket: Socket,
  frames: AsyncIterator<{ kind: BrokerFrameKind; payload: Buffer }>,
  identity: BrokerConnectionIdentity,
  requestId: string,
  role: 'controller' | 'operation'
): Promise<void> {
  await writeControlFrame(socket, {
    type: 'auth',
    protocol: HOST_FILES_PROTOCOL,
    generation: identity.generation,
    capability: identity.capability,
    requestId,
    role
  });
  const response = await nextControl(frames);
  // accept only the exact acknowledgement
  if (isRecord(response) && response.type === 'authenticated') return;
  throw brokerError(response);
}

// use a private authenticated UDS for bridged host execution
export class HostBrokerBackend implements HostFilesBackend {
  private readonly operationSockets = new Set<Socket>();
  private controller?: Socket;
  private activeGeneration = '';
  private closed = false;

  // require per-connection identity validation from the lifecycle owner
  constructor(private readonly validateIdentity: BrokerIdentityValidator) {}

  // establish the single controller lease before exposing the backend
  static async connect(validateIdentity: BrokerIdentityValidator): Promise<HostBrokerBackend> {
    const backend = new HostBrokerBackend(validateIdentity);
    await backend.openController();
    return backend;
  }

  // return the verified active generation
  generation(): string {
    return this.activeGeneration;
  }

  // open the controller whose EOF cancels host work
  private async openController(): Promise<void> {
    const identity = await this.validateIdentity();
    const socket = await connectSocket(identity);
    const frames = decodeBrokerFrames(socket)[Symbol.asyncIterator]();
    // close the failed socket before surfacing auth errors
    try {
      await authenticateOperation(socket, frames, identity, randomUUID(), 'controller');
    } catch (error) {
      socket.destroy();
      throw error;
    }
    this.controller = socket;
    this.activeGeneration = identity.generation;
    // invalidate operation transports when the controller disappears
    socket.once('close', () => {
      // ignore the expected close path
      if (this.closed) return;
      this.activeGeneration = '';
      // abort every outstanding request
      for (const operation of this.operationSockets) operation.destroy();
    });
    // drain controller frames to prevent socket pressure
    void (async () => {
      // accept only a terminal shutdown response
      for await (const frame of { [Symbol.asyncIterator]: () => frames }) {
        // ignore bounded diagnostics/control acknowledgements
        if (frame.kind === BrokerFrameKind.Control) decodeControlPayload(frame.payload);
      }
    })().catch(() => socket.destroy());
  }

  // open and authenticate one independently cancellable operation
  private async operation(signal?: AbortSignal): Promise<{
    socket: Socket;
    frames: AsyncIterator<{ kind: BrokerFrameKind; payload: Buffer }>;
    release: () => void;
  }> {
    // reject work after close or controller loss
    if (this.closed || this.controller?.destroyed !== false) throw new HostFilesTransportError('bridge_unavailable', 'host files broker is unavailable');
    const identity = await this.validateIdentity();
    // reject implicit generation rotation
    if (identity.generation !== this.activeGeneration) throw new HostFilesTransportError('bridge_unavailable', 'host files broker generation changed');
    const socket = await connectSocket(identity);
    const iterator = decodeBrokerFrames(socket)[Symbol.asyncIterator]();
    const unbind = bindAbort(socket, signal);
    this.operationSockets.add(socket);
    // release listeners and membership exactly once
    const release = () => {
      unbind();
      this.operationSockets.delete(socket);
      // close the completed request connection
      if (!socket.destroyed) socket.end();
    };
    // authenticate before sending a command
    try {
      await authenticateOperation(socket, iterator, identity, randomUUID(), 'operation');
      return { socket, frames: iterator, release };
    } catch (error) {
      release();
      socket.destroy();
      throw error;
    }
  }

  // execute one bounded JSON command
  async request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>> {
    const operation = await this.operation(signal);
    // always release the operation socket
    try {
      await writeControlFrame(operation.socket, { type: 'request', mode: 'request', command }, signal);
      const response = await nextControl(operation.frames);
      // accept only result envelopes
      if (isRecord(response) && response.type === 'result') {
        const result = response.result;
        // reject malformed omission metadata at the broker trust boundary
        if (command.kind === 'list' && (!isRecord(result) || typeof result.inaccessibleEntries !== 'number' || !Number.isSafeInteger(result.inaccessibleEntries) || result.inaccessibleEntries < 0 || result.inaccessibleEntries > command.maxEntries)) throw new HostFilesTransportError('protocol_error', 'invalid broker directory listing');
        return result as HostFilesCommandResult<T>;
      }
      throw brokerError(response);
    } finally {
      operation.release();
    }
  }

  // expose broker bytes through a backpressured Node stream
  async read(command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable> {
    const operation = await this.operation(signal);
    await writeControlFrame(operation.socket, { type: 'request', mode: 'read', command }, signal);
    const output = new PassThrough({ highWaterMark: MAX_READ_HIGH_WATER_MARK });
    // pump protocol frames only while the consumer accepts bytes
    void (async () => {
      try {
        // consume binary frames until the broker's end marker
        while (true) {
          const next = await operation.frames.next();
          // reject unexpected EOF
          if (next.done) throw new HostFilesTransportError('bridge_unavailable', 'host files broker disconnected');
          // preserve consumer backpressure
          if (next.value.kind === BrokerFrameKind.Binary) {
            // await the readable consumer before reading more socket frames
            if (!output.write(next.value.payload)) await new Promise<void>((resolve, reject) => {
              // remove losing listeners after one terminal event
              const cleanup = () => {
                output.removeListener('drain', drained);
                output.removeListener('error', failed);
                output.removeListener('close', closed);
              };
              // resume when the consumer drains
              const drained = () => { cleanup(); resolve(); };
              // propagate consumer errors
              const failed = (error: Error) => { cleanup(); reject(error); };
              // reject consumer disconnect
              const closed = () => { cleanup(); reject(new Error('download consumer disconnected')); };
              output.once('drain', drained);
              output.once('error', failed);
              output.once('close', closed);
            });
            continue;
          }
          const control = decodeControlPayload(next.value.payload);
          // finish only on the exact stream marker
          if (isRecord(control) && control.type === 'end') break;
          throw brokerError(control);
        }
        output.end();
      } catch (error) {
        output.destroy(error instanceof Error ? error : new Error('host files read failed'));
      } finally {
        operation.release();
      }
    })();
    // consumer disconnect cancels the actual host operation
    output.once('close', () => {
      // stop only incomplete transfers
      if (!output.readableEnded && !operation.socket.destroyed) {
        void writeControlFrame(operation.socket, { type: 'cancel' }).catch(() => {}).finally(() => operation.socket.destroy());
      }
    });
    return output;
  }

  // upload exact binary bytes and await the publication result
  async write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    const operation = await this.operation(signal);
    // always cancel or close the operation transport
    try {
      await writeControlFrame(operation.socket, { type: 'request', mode: 'write', command }, signal);
      await writeBinaryFrames(operation.socket, source, signal);
      const response = await nextControl(operation.frames);
      // accept only the write result envelope
      if (isRecord(response) && response.type === 'result') return response.result as HostFilesWriteResult;
      throw brokerError(response);
    } finally {
      operation.release();
    }
  }

  // close the controller and every active operation
  async close(): Promise<void> {
    // make close idempotent
    if (this.closed) return;
    this.closed = true;
    // cancel operations before stopping the broker
    for (const socket of this.operationSockets) {
      await writeControlFrame(socket, { type: 'cancel' }).catch(() => {});
      socket.destroy();
    }
    this.operationSockets.clear();
    // request fail-stop broker shutdown
    if (this.controller !== undefined && !this.controller.destroyed) {
      await writeControlFrame(this.controller, { type: 'shutdown' }).catch(() => {});
      this.controller.end();
    }
    this.activeGeneration = '';
  }
}

// limit buffered response data while preserving ordinary throughput
const MAX_READ_HIGH_WATER_MARK = 64 * 1024;
