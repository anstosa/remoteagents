import type { Readable, Writable } from 'node:stream';

// keep one protocol number for broker compatibility checks
export const HOST_FILES_PROTOCOL = 1;
// bound control memory independently from streamed file bytes
export const MAX_CONTROL_FRAME_BYTES = 8 * 1024 * 1024;
// keep binary chunks small enough for responsive cancellation
export const MAX_BINARY_FRAME_BYTES = 64 * 1024;

export enum BrokerFrameKind {
  Control = 1,
  Binary = 2
}

export type BrokerRole = 'controller' | 'operation';
export type BrokerMode = 'request' | 'read' | 'write';
export type BrokerAuthFrame = {
  type: 'auth';
  protocol: number;
  generation: string;
  capability: string;
  requestId: string;
  role: BrokerRole;
};
export type BrokerRequestFrame = { type: 'request'; mode: BrokerMode; command: unknown };
export type BrokerResultFrame = { type: 'result'; result: unknown };
export type BrokerErrorFrame = { type: 'error'; code: string; message: string };
export type BrokerControlFrame = BrokerAuthFrame | BrokerRequestFrame | BrokerResultFrame | BrokerErrorFrame | {
  type: 'authenticated' | 'cancel' | 'end' | 'shutdown' | 'shutdown-complete';
};
export type DecodedBrokerFrame = { kind: BrokerFrameKind; payload: Buffer };

// identify stable transport failures without exposing broker details
export class HostFilesTransportError extends Error {
  readonly code: 'bridge_unavailable' | 'broker_busy' | 'protocol_error';

  // preserve the stable public error code
  constructor(code: HostFilesTransportError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostFilesTransportError';
    this.code = code;
  }
}

// validate plain control objects before dispatch
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// validate bounded opaque identifiers
export function isBrokerIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\0\r\n]/u.test(value);
}

// validate the first authenticated frame
export function isBrokerAuthFrame(value: unknown): value is BrokerAuthFrame {
  // require the exact authentication shape
  if (!isRecord(value)) return false;
  return value.type === 'auth'
    && value.protocol === HOST_FILES_PROTOCOL
    && isBrokerIdentifier(value.generation)
    && isBrokerIdentifier(value.capability)
    && isBrokerIdentifier(value.requestId)
    && (value.role === 'controller' || value.role === 'operation');
}

// validate operation control envelopes
export function isBrokerRequestFrame(value: unknown): value is BrokerRequestFrame {
  // require a known transport mode
  if (!isRecord(value) || value.type !== 'request') return false;
  return (value.mode === 'request' || value.mode === 'read' || value.mode === 'write') && isRecord(value.command);
}

// encode one bounded length-prefixed frame
export function encodeBrokerFrame(kind: BrokerFrameKind, payload: Uint8Array): Buffer {
  const limit = kind === BrokerFrameKind.Control ? MAX_CONTROL_FRAME_BYTES : MAX_BINARY_FRAME_BYTES;
  // reject unbounded allocation at the source
  if (payload.byteLength > limit) throw new HostFilesTransportError('protocol_error', 'broker frame exceeds limit');
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt8(kind, 0);
  frame.writeUInt32BE(payload.byteLength, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 5);
  return frame;
}

// encode JSON as a control frame
export function encodeControlFrame(frame: BrokerControlFrame): Buffer {
  return encodeBrokerFrame(BrokerFrameKind.Control, Buffer.from(JSON.stringify(frame), 'utf8'));
}

// decode one complete JSON payload
export function decodeControlPayload(payload: Buffer): unknown {
  // reject invalid JSON as a protocol failure
  try {
    return JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    throw new HostFilesTransportError('protocol_error', 'invalid broker control frame');
  }
}

// parse fragmented and coalesced byte chunks without buffering stream bodies
export async function* decodeBrokerFrames(source: AsyncIterable<Uint8Array>): AsyncGenerator<DecodedBrokerFrame> {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  // consume input at the caller's pace for socket backpressure
  for await (const chunk of source) {
    buffered = buffered.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([buffered, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    // drain every complete coalesced frame
    while (buffered.length >= 5) {
      const kind = buffered.readUInt8(0);
      // reject unknown frame kinds before trusting the length
      if (kind !== BrokerFrameKind.Control && kind !== BrokerFrameKind.Binary) throw new HostFilesTransportError('protocol_error', 'unknown broker frame kind');
      const length = buffered.readUInt32BE(1);
      const limit = kind === BrokerFrameKind.Control ? MAX_CONTROL_FRAME_BYTES : MAX_BINARY_FRAME_BYTES;
      // reject declared oversized frames before buffering their bodies
      if (length > limit) throw new HostFilesTransportError('protocol_error', 'broker frame exceeds limit');
      // wait for the remaining fragmented bytes
      if (buffered.length < 5 + length) break;
      const payload = Buffer.from(buffered.subarray(5, 5 + length));
      buffered = buffered.subarray(5 + length);
      yield { kind, payload };
    }
  }
  // reject truncated headers and bodies
  if (buffered.length !== 0) throw new HostFilesTransportError('protocol_error', 'truncated broker frame');
}

// preserve Writable backpressure for every protocol frame
export async function writeBrokerFrame(destination: Writable, frame: Uint8Array, signal?: AbortSignal): Promise<void> {
  // stop before writing after cancellation
  if (signal?.aborted === true) throw signal.reason ?? new Error('aborted');
  // reject transports that already closed
  if (destination.destroyed || destination.writableEnded) throw new HostFilesTransportError('bridge_unavailable', 'broker transport closed');
  // await kernel and stream pressure
  if (destination.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    // remove losing listeners after the first terminal event
    const cleanup = () => {
      destination.removeListener('drain', drained);
      destination.removeListener('error', failed);
      destination.removeListener('close', closed);
      signal?.removeEventListener('abort', aborted);
    };
    // resume after the destination drains
    const drained = () => { cleanup(); resolve(); };
    // propagate stream errors
    const failed = (error: Error) => { cleanup(); reject(error); };
    // reject a closed destination
    const closed = () => { cleanup(); reject(new HostFilesTransportError('bridge_unavailable', 'broker transport closed')); };
    // propagate operation cancellation
    const aborted = () => { cleanup(); reject(signal?.reason ?? new Error('aborted')); };
    destination.once('drain', drained);
    destination.once('error', failed);
    destination.once('close', closed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

// write one control envelope with backpressure
export async function writeControlFrame(destination: Writable, frame: BrokerControlFrame, signal?: AbortSignal): Promise<void> {
  await writeBrokerFrame(destination, encodeControlFrame(frame), signal);
}

// stream exact bytes into binary frames without UTF-8 conversion
export async function writeBinaryFrames(destination: Writable, source: Readable, signal?: AbortSignal): Promise<void> {
  // forward chunks at the destination's pace
  for await (const value of source) {
    // normalize strings defensively while preserving Buffer bytes
    const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
    // split oversized upstream chunks at the protocol bound
    for (let offset = 0; offset < chunk.length; offset += MAX_BINARY_FRAME_BYTES) {
      await writeBrokerFrame(destination, encodeBrokerFrame(BrokerFrameKind.Binary, chunk.subarray(offset, offset + MAX_BINARY_FRAME_BYTES)), signal);
    }
  }
  await writeControlFrame(destination, { type: 'end' }, signal);
}
