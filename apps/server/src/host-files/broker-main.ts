import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  HostFilesError,
  isHostFilesCommand,
  isHostFilesReadCommand,
  isHostFilesWriteCommand,
  type HostFilesBackend
} from './contracts.js';
import { createHostFilesEngine } from './engine.js';
import {
  BrokerFrameKind,
  HOST_FILES_PROTOCOL,
  HostFilesTransportError,
  decodeBrokerFrames,
  decodeControlPayload,
  isBrokerAuthFrame,
  isBrokerRequestFrame,
  isRecord,
  writeBinaryFrames,
  writeControlFrame
} from './protocol.js';

export type HostBrokerDescriptor = {
  version: 1;
  protocol: number;
  generation: string;
  capability: string;
  serverInstanceId: string;
  socketPath: string;
  runtimeDirectory: string;
  operationJournalPath: string;
  fileFavoritesPath: string;
  uid: number;
  programDigest: string;
};

// validate bounded descriptor strings before filesystem use
function isDescriptorString(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

// validate the private bootstrap descriptor
export function isHostBrokerDescriptor(value: unknown): value is HostBrokerDescriptor {
  // require one exact versioned descriptor
  if (!isRecord(value)) return false;
  return value.version === 1
    && value.protocol === HOST_FILES_PROTOCOL
    && isDescriptorString(value.generation, 256)
    && isDescriptorString(value.capability, 256)
    && isDescriptorString(value.serverInstanceId, 256)
    && isDescriptorString(value.socketPath)
    && isAbsolute(value.socketPath)
    && isDescriptorString(value.runtimeDirectory)
    && isAbsolute(value.runtimeDirectory)
    && isDescriptorString(value.operationJournalPath)
    && isAbsolute(value.operationJournalPath)
    && isDescriptorString(value.fileFavoritesPath)
    && isAbsolute(value.fileFavoritesPath)
    && Number.isSafeInteger(value.uid)
    && Number(value.uid) >= 0
    && typeof value.programDigest === 'string'
    && /^[a-f0-9]{64}$/u.test(value.programDigest);
}

// compare secrets without content-dependent timing
function capabilityMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

// serialize only stable error codes and bounded public messages
function publicBrokerError(error: unknown): { type: 'error'; code: string; message: string } {
  // retain intentional service errors
  if (error instanceof HostFilesError) return { type: 'error', code: error.code, message: error.message.slice(0, 512) };
  // retain protocol failures without internal details
  if (error instanceof HostFilesTransportError) return { type: 'error', code: error.code, message: error.message.slice(0, 512) };
  // collapse raw filesystem and implementation errors
  return { type: 'error', code: 'bridge_unavailable', message: 'host files operation failed' };
}

// verify private descriptor ownership and permissions
async function loadDescriptor(path: string): Promise<HostBrokerDescriptor> {
  // require an absolute fixed argv path
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new Error('invalid descriptor path');
  const metadata = await lstat(path);
  // reject widened or foreign bootstrap files
  if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error('invalid descriptor identity');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  // reject malformed descriptors before creating a socket
  if (!isHostBrokerDescriptor(parsed) || parsed.uid !== process.getuid?.()) throw new Error('invalid broker descriptor');
  return parsed;
}

// remove only the broker's exact socket pathname
async function removeOwnedSocket(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  // leave absent paths unchanged
  if (metadata === undefined) return;
  // unlink only an owned Unix socket
  if (!metadata.isSocket() || metadata.uid !== uid) throw new Error('socket path is not owned');
  await rm(path);
}

// stream one upload connection into the shared engine
async function handleWrite(
  socket: Socket,
  frames: AsyncIterator<{ kind: BrokerFrameKind; payload: Buffer }>,
  engine: HostFilesBackend,
  command: unknown,
  controllerSignal: AbortSignal,
  operation: AbortController
): Promise<void> {
  // reject unknown stream commands before accepting bytes
  if (!isHostFilesWriteCommand(command)) throw new HostFilesError('invalid_request', 'invalid write command', 400);
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  const write = engine.write(command, input, operation.signal).then(
    result => ({ result }),
    error => ({ error })
  );
  // stop the operation when its controller ends
  const controllerAbort = () => operation.abort(controllerSignal.reason);
  controllerSignal.addEventListener('abort', controllerAbort, { once: true });
  try {
    // consume framed upload bytes at the engine's pace
    while (true) {
      const next = await frames.next();
      // abort truncated uploads
      if (next.done) throw new HostFilesError('invalid_request', 'upload ended early', 400);
      // apply stream backpressure before reading another socket frame
      if (next.value.kind === BrokerFrameKind.Binary) {
        // pause socket intake behind the engine sink
        if (!input.write(next.value.payload)) await new Promise<void>((resolve, reject) => {
          // remove the losing listener after one terminal event
          const cleanup = () => {
            input.removeListener('drain', drained);
            input.removeListener('error', failed);
          };
          // resume after the engine consumes buffered bytes
          const drained = () => { cleanup(); resolve(); };
          // propagate engine input failures
          const failed = (error: Error) => { cleanup(); reject(error); };
          input.once('drain', drained);
          input.once('error', failed);
        });
        continue;
      }
      const control = decodeControlPayload(next.value.payload);
      // finish the source only on the exact marker
      if (isRecord(control) && control.type === 'end') break;
      // propagate explicit cancellation
      if (isRecord(control) && control.type === 'cancel') throw new Error('operation canceled');
      throw new HostFilesTransportError('protocol_error', 'unexpected upload control frame');
    }
    input.end();
    const outcome = await write;
    // propagate the already-settled engine failure
    if ('error' in outcome) throw outcome.error;
    await writeControlFrame(socket, { type: 'result', result: outcome.result }, operation.signal);
  } catch (error) {
    // settle engine cleanup before surfacing transport cancellation
    input.destroy(error instanceof Error ? error : new Error('upload canceled'));
    await write;
    throw error;
  } finally {
    controllerSignal.removeEventListener('abort', controllerAbort);
    // ensure engine cleanup sees incomplete uploads
    if (!input.readableEnded) input.destroy(new Error('upload canceled'));
  }
}

// execute one authenticated operation connection
async function handleOperation(
  socket: Socket,
  frames: AsyncIterator<{ kind: BrokerFrameKind; payload: Buffer }>,
  engine: HostFilesBackend,
  controllerSignal: AbortSignal,
  operations: Set<AbortController>
): Promise<void> {
  const operation = new AbortController();
  operations.add(operation);
  // cancel actual host work on disconnect
  const disconnect = () => operation.abort(new Error('operation disconnected'));
  socket.once('close', disconnect);
  // cancel actual host work on controller EOF
  const controllerAbort = () => operation.abort(controllerSignal.reason);
  controllerSignal.addEventListener('abort', controllerAbort, { once: true });
  try {
    const next = await frames.next();
    // require one request immediately after authentication
    if (next.done || next.value.kind !== BrokerFrameKind.Control) throw new HostFilesTransportError('protocol_error', 'missing broker request');
    const request = decodeControlPayload(next.value.payload);
    // reject unknown request envelopes
    if (!isBrokerRequestFrame(request)) throw new HostFilesError('invalid_request', 'invalid broker request', 400);
    // dispatch bounded metadata and mutation commands
    if (request.mode === 'request') {
      // admit only the frozen command union
      if (!isHostFilesCommand(request.command)) throw new HostFilesError('invalid_request', 'unknown host files command', 400);
      await writeControlFrame(socket, { type: 'result', result: await engine.request(request.command, operation.signal) }, operation.signal);
      return;
    }
    // dispatch descriptor-backed downloads
    if (request.mode === 'read') {
      // validate the bounded read envelope
      if (!isHostFilesReadCommand(request.command)) throw new HostFilesError('invalid_request', 'invalid read command', 400);
      const stream = await engine.read(request.command, operation.signal);
      // destroy the source when the transport cancels
      operation.signal.addEventListener('abort', () => stream.destroy(operation.signal.reason instanceof Error ? operation.signal.reason : undefined), { once: true });
      await writeBinaryFrames(socket, stream, operation.signal);
      return;
    }
    await handleWrite(socket, frames, engine, request.command, controllerSignal, operation);
  } catch (error) {
    // abort the actual engine work on transport/write failure
    if (!operation.signal.aborted) operation.abort(error);
    throw error;
  } finally {
    socket.removeListener('close', disconnect);
    controllerSignal.removeEventListener('abort', controllerAbort);
    operations.delete(operation);
  }
}

// serve one authenticated generation until controller EOF
export async function runHostBroker(
  descriptorPath: string,
  engineFactory: (generation: string, options?: { journalFile?: string; favoritesFile?: string }) => HostFilesBackend = createHostFilesEngine
): Promise<void> {
  const descriptor = await loadDescriptor(descriptorPath);
  const uid = process.getuid?.();
  // fail closed when the host runtime cannot prove uid parity
  if (uid === undefined || uid !== descriptor.uid) throw new Error('broker uid mismatch');
  await mkdir(descriptor.runtimeDirectory, { recursive: false, mode: 0o700 }).catch(async (error: unknown) => {
    const metadata = await lstat(descriptor.runtimeDirectory).catch(() => undefined);
    // reuse only one already-private owned directory
    if (metadata === undefined || !metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) throw error;
  });
  // refuse a pre-existing non-owned socket path
  await removeOwnedSocket(descriptor.socketPath, uid);
  const engine = engineFactory(descriptor.generation, { journalFile: descriptor.operationJournalPath, favoritesFile: descriptor.fileFavoritesPath });
  const operations = new Set<AbortController>();
  const controllerAbort = new AbortController();
  let controller: Socket | undefined;
  let stopping = false;
  let server: Server;
  const stopped = new Promise<void>((resolve, reject) => {
    // accept authenticated controller or operation connections
    server = createServer((socket) => {
      void (async () => {
        const frames = decodeBrokerFrames(socket)[Symbol.asyncIterator]();
        const first = await frames.next();
        // require authentication as the first frame
        if (first.done || first.value.kind !== BrokerFrameKind.Control) throw new HostFilesTransportError('protocol_error', 'missing broker authentication');
        const auth = decodeControlPayload(first.value.payload);
        // bind every connection to this exact generation
        if (!isBrokerAuthFrame(auth)
          || auth.generation !== descriptor.generation
          || !capabilityMatches(auth.capability, descriptor.capability)) {
          throw new HostFilesTransportError('bridge_unavailable', 'broker authentication failed');
        }
        // hold exactly one controller lease
        if (auth.role === 'controller') {
          // reject a concurrent controller
          if (controller !== undefined && !controller.destroyed) throw new HostFilesTransportError('broker_busy', 'host files broker already has a controller');
          controller = socket;
          await writeControlFrame(socket, { type: 'authenticated' });
          // controller EOF is the fail-stop lifecycle boundary
          try {
            // drain bounded controller commands until shutdown or EOF
            while (true) {
              const next = await frames.next();
              // exit on controller EOF
              if (next.done) break;
              // reject binary controller payloads
              if (next.value.kind !== BrokerFrameKind.Control) throw new HostFilesTransportError('protocol_error', 'unexpected controller binary frame');
              const control = decodeControlPayload(next.value.payload);
              // honor the graceful shutdown request
              if (isRecord(control) && control.type === 'shutdown') {
                stopping = true;
                await writeControlFrame(socket, { type: 'shutdown-complete' }).catch(() => {});
                break;
              }
            }
          } finally {
            // abort every actual operation before process exit
            if (!controllerAbort.signal.aborted) controllerAbort.abort(new Error('controller disconnected'));
            // propagate controller loss to every operation
            for (const operation of operations) operation.abort(controllerAbort.signal.reason);
            socket.end();
            server.close();
          }
          return;
        }
        // require a live controller for operation intake
        if (controller === undefined || controller.destroyed || controllerAbort.signal.aborted) throw new HostFilesTransportError('bridge_unavailable', 'broker controller is unavailable');
        await writeControlFrame(socket, { type: 'authenticated' });
        await handleOperation(socket, frames, engine, controllerAbort.signal, operations);
      })().catch(async (error: unknown) => {
        await writeControlFrame(socket, publicBrokerError(error)).catch(() => {});
        socket.destroy();
      });
    });
    server.once('error', reject);
    server.once('close', resolve);
  });
  // listen only on the private Unix socket
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(descriptor.socketPath, resolve);
  });
  await chmod(descriptor.socketPath, 0o600);
  try {
    await stopped;
  } finally {
    // await shared engine cleanup before removing transport state
    await engine.close().catch(() => {});
    await removeOwnedSocket(descriptor.socketPath, uid).catch(() => {});
    // remove only an empty exact runtime directory
    await rmdir(descriptor.runtimeDirectory).catch(() => {});
    // surface abnormal fail-stop only through process status
    if (!stopping && controller !== undefined) controller.destroy();
  }
}

// run only when invoked as the fixed host entrypoint
const entry = process.argv[1] === undefined ? undefined : fileURLToPath(import.meta.url) === process.argv[1];
// preserve import safety for tests and snapshots
if (entry) {
  const descriptor = process.argv[2];
  // require the one fixed descriptor argv
  if (descriptor === undefined || process.argv.length !== 3) process.exitCode = 64;
  else await runHostBroker(descriptor).catch(() => { process.exitCode = 1; });
}
