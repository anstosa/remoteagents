import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { HostBrokerBackend } from '../src/host-files/backend.js';
import { LazyHostBrokerBackend, posixShellLiteral, renderHostBrokerLauncher } from '../src/host-files/broker.js';
import { runHostBroker } from '../src/host-files/broker-main.js';
import type {
  HostFileIdentity,
  HostFilesBackend,
  HostFilesCommand,
  HostFilesCommandResult,
  HostFilesReadCommand,
  HostFilesWriteCommand,
  HostFilesWriteResult
} from '../src/host-files/contracts.js';
import { HostFilesError } from '../src/host-files/contracts.js';
import { BrokerFrameKind, HOST_FILES_PROTOCOL, MAX_CONTROL_FRAME_BYTES, decodeBrokerFrames, encodeBrokerFrame } from '../src/host-files/protocol.js';

const execute = promisify(execFile);
const fixtures: string[] = [];

// remove only test-owned fixture directories
afterEach(async () => {
  // clean every fixture created by the current test
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

// create one private disposable test root
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-host-files-broker-'));
  fixtures.push(directory);
  return directory;
}

const staleBrokerSession = `rac-files-${'d'.repeat(24)}`;
const staleBrokerNonce = '00000000-0000-4000-8000-000000000001';

// identify one test-owned persisted file
async function persistedIdentity(path: string): Promise<{ dev: string; ino: string; uid: number; mode: number; kind: 'file' }> {
  const metadata = await lstat(path, { bigint: true });
  return { dev: String(metadata.dev), ino: String(metadata.ino), uid: Number(metadata.uid), mode: Number(metadata.mode & 0o777n), kind: 'file' };
}

// read the current process identity using the production proc layout
async function currentProcessStartTime(): Promise<string> {
  const value = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]!;
}

// create one expired ready owner from a prior controller
async function staleBrokerFixture(
  commandRunner: NonNullable<ConstructorParameters<typeof LazyHostBrokerBackend>[0]['commandRunner']>,
  options: { hostProcRoot?: string; ownerPidStartTime?: string; state?: 'launching' | 'ready' } = {}
): Promise<{
  backend: LazyHostBrokerBackend;
  descriptorPath: string;
  generation: string;
  lockPath: string;
  ownerPath: string;
}> {
  const root = await fixture();
  const dataDirectory = join(root, '.data', 'host-files');
  const compiledModuleDirectory = join(root, 'compiled');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  await mkdir(compiledModuleDirectory, { mode: 0o700 });
  await writeFile(join(compiledModuleDirectory, 'broker-main.js'), 'export {};\n', { mode: 0o600 });
  const generation = randomUUID();
  const descriptorPath = join(dataDirectory, `descriptor-${generation}.json`);
  const lockPath = join(dataDirectory, 'owner.lock');
  const ownerPath = join(dataDirectory, 'owner.json');
  await writeFile(descriptorPath, '{}\n', { mode: 0o600 });
  const descriptorIdentity = await persistedIdentity(descriptorPath);
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const state = options.state ?? 'ready';
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    serverInstanceId: randomUUID(),
    pid: process.pid,
    pidStartTime: '0',
    createdAt
  })}\n`, { mode: 0o600 });
  await writeFile(ownerPath, `${JSON.stringify({
    version: 1,
    state,
    protocol: HOST_FILES_PROTOCOL,
    programDigest: 'a'.repeat(64),
    launcherDigest: 'b'.repeat(64),
    ownerKey: 'c'.repeat(24),
    expectedSessionName: staleBrokerSession,
    launchNonce: staleBrokerNonce,
    serverInstanceId: randomUUID(),
    generation,
    capabilityHash: 'e'.repeat(64),
    descriptorPath,
    descriptorIdentity,
    createdAt,
    ...(state === 'ready' ? {
      sessionId: '$99',
      sessionName: staleBrokerSession,
      paneId: '%99',
      pid: process.pid,
      pidStartTime: options.ownerPidStartTime ?? '0',
      uid: process.getuid?.() ?? 0,
      executable: process.execPath,
      cmdlineDigest: 'f'.repeat(64),
      hostRuntimePath: join(root, 'runtime'),
      runtimePath: join(root, 'runtime'),
      runtimeIdentity: descriptorIdentity,
      hostSocketPath: join(root, 'runtime', 'broker.sock'),
      socketPath: join(root, 'runtime', 'broker.sock'),
      socketIdentity: descriptorIdentity
    } : {})
  })}\n`, { mode: 0o600 });
  const backend = new LazyHostBrokerBackend({
    tmuxBinary: '/usr/bin/tmux',
    hostTmuxSocket: join(root, 'tmux.sock'),
    hostProcRoot: options.hostProcRoot ?? '/proc',
    serverCheckout: root,
    hostCheckout: root,
    hostNodeBin: process.execPath,
    hostUid: process.getuid?.() ?? 0,
    operationJournalPath: join(root, 'journal.json'),
    fileFavoritesPath: join(root, 'favorites.json'),
    shutdownTimeoutMs: 25,
    compiledModuleDirectory,
    commandRunner
  });
  return { backend, descriptorPath, generation, lockPath, ownerPath };
}

// render one readable synthetic proc identity
function syntheticProcStat(pid: number, startTime: string): string {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = 'S';
  fields[19] = startTime;
  return `${pid} (broker fixture) ${fields.join(' ')}\n`;
}

// create one in-memory ready owner backed by exact persisted recovery files
async function ownedReadyBrokerFixture(
  commandRunner: NonNullable<ConstructorParameters<typeof LazyHostBrokerBackend>[0]['commandRunner']>,
  procStat: string
): Promise<{
  backend: LazyHostBrokerBackend;
  descriptorPath: string;
  lockPath: string;
  ownerPath: string;
  procStatPath: string;
}> {
  const root = await fixture();
  const dataDirectory = join(root, '.data', 'host-files');
  const procDirectory = join(root, 'proc', '4242');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(procDirectory, { recursive: true, mode: 0o700 });
  const descriptorPath = join(dataDirectory, 'descriptor.json');
  const lockPath = join(dataDirectory, 'owner.lock');
  const ownerPath = join(dataDirectory, 'owner.json');
  const procStatPath = join(procDirectory, 'stat');
  await writeFile(descriptorPath, '{}\n', { mode: 0o600 });
  await writeFile(lockPath, '{}\n', { mode: 0o600 });
  await writeFile(procStatPath, procStat, { mode: 0o600 });
  const descriptorIdentity = await persistedIdentity(descriptorPath);
  const backend = new LazyHostBrokerBackend({
    tmuxBinary: '/usr/bin/tmux',
    hostTmuxSocket: join(root, 'tmux.sock'),
    hostProcRoot: join(root, 'proc'),
    serverCheckout: root,
    hostCheckout: root,
    hostNodeBin: process.execPath,
    hostUid: process.getuid?.() ?? 0,
    operationJournalPath: join(root, 'journal.json'),
    fileFavoritesPath: join(root, 'favorites.json'),
    shutdownTimeoutMs: 25,
    commandRunner
  });
  const mutable = backend as unknown as {
    serverInstanceId: string;
    generationId: string;
    dataDirectory: string;
    hostDataDirectory: string;
    ownerPath: string;
    lockPath: string;
    owner: Record<string, unknown>;
    lockIdentity: Awaited<ReturnType<typeof persistedIdentity>>;
  };
  const owner = {
    version: 1,
    state: 'ready',
    protocol: HOST_FILES_PROTOCOL,
    programDigest: 'a'.repeat(64),
    launcherDigest: 'b'.repeat(64),
    ownerKey: 'c'.repeat(24),
    expectedSessionName: staleBrokerSession,
    launchNonce: staleBrokerNonce,
    serverInstanceId: mutable.serverInstanceId,
    generation: mutable.generationId,
    capabilityHash: 'e'.repeat(64),
    descriptorPath,
    descriptorIdentity,
    createdAt: new Date().toISOString(),
    sessionId: '$99',
    sessionName: staleBrokerSession,
    paneId: '%99',
    pid: 4242,
    pidStartTime: '12345',
    uid: process.getuid?.() ?? 0,
    executable: process.execPath,
    cmdlineDigest: 'f'.repeat(64),
    hostRuntimePath: join(root, 'runtime'),
    runtimePath: join(root, 'runtime'),
    runtimeIdentity: descriptorIdentity,
    hostSocketPath: join(root, 'runtime', 'broker.sock'),
    socketPath: join(root, 'runtime', 'broker.sock'),
    socketIdentity: descriptorIdentity
  };
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  mutable.dataDirectory = dataDirectory;
  mutable.hostDataDirectory = dataDirectory;
  mutable.ownerPath = ownerPath;
  mutable.lockPath = lockPath;
  mutable.owner = owner;
  mutable.lockIdentity = await persistedIdentity(lockPath);
  return { backend, descriptorPath, lockPath, ownerPath, procStatPath };
}

// wait for one asynchronous broker condition
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // retry within the bounded test deadline
  while (Date.now() < deadline) {
    // stop after the first successful check
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for broker fixture');
}

// return one stable synthetic identity
function identity(size = 0): HostFileIdentity {
  return { dev: '1', ino: '2', ctimeNs: '3', mtimeNs: '4', size: String(size), nlink: '1', kind: 'file' };
}

class BrokerFixtureEngine implements HostFilesBackend {
  readonly uploads: Buffer[] = [];
  readonly requestSignals: AbortSignal[] = [];
  readStarted = false;
  readDestroyed = false;

  // bind the test engine to one generation
  constructor(private readonly generationId: string, private readonly binary: Buffer) {}

  // expose the fixture generation
  generation(): string {
    return this.generationId;
  }

  // return one known inspect result or hold a cancel probe
  async request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>> {
    // preserve engine limit failures without dropping the generation
    if (command.kind === 'inspect' && command.path.endsWith('/limit')) throw new HostFilesError('limit_exceeded', 'metadata exceeds limit', 413);
    // preserve favorite recovery conflicts as intentional 409 responses
    if (command.kind === 'inspect' && command.path.endsWith('/favorite-replaced')) throw new HostFilesError('favorite_replaced', 'favorite points to another object', 409);
    // hold the explicit cancellation probe until abort
    if (command.kind === 'inspect' && command.path.endsWith('/pending')) {
      if (signal !== undefined) this.requestSignals.push(signal);
      await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return {
      ...identity(this.binary.length),
      path: command.kind === 'inspect' ? command.path : '/fixture',
      name: 'fixture',
      uid: process.getuid?.() ?? 0,
      owner: 'fixture',
      permissions: 'rw-------',
      mode: 0o600,
      modifiedAt: new Date(0).toISOString(),
      sizeBytes: this.binary.length
    } as HostFilesCommandResult<T>;
  }

  // stream binary fixture bytes and record transport cancellation
  async read(_command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable> {
    this.readStarted = true;
    const stream = Readable.from((async function* (binary: Buffer) {
      // produce many bounded chunks for backpressure
      for (let offset = 0; offset < binary.length; offset += 4096) yield binary.subarray(offset, offset + 4096);
    })(this.binary));
    // destroy the actual source when the operation aborts
    signal?.addEventListener('abort', () => {
      this.readDestroyed = true;
      stream.destroy(signal.reason instanceof Error ? signal.reason : undefined);
    }, { once: true });
    return stream;
  }

  // consume upload chunks slowly enough to exercise backpressure
  async write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult> {
    let bytes = 0;
    // consume exact binary chunks without text decoding
    for await (const value of source) {
      // stop the host operation after cancellation
      if (signal?.aborted === true) throw signal.reason;
      const chunk = Buffer.from(value as Uint8Array);
      bytes += chunk.length;
      this.uploads.push(chunk);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    return { path: command.path, bytesWritten: bytes, identity: identity(bytes) };
  }

  // provide one no-op engine close
  async close(): Promise<void> {}
}

// launch one real private UDS broker around a fixture engine
async function brokerFixture(binary = Buffer.from([0, 0xff, 0xfe, 0x41])): Promise<{
  backend: HostBrokerBackend;
  engine: BrokerFixtureEngine;
  broker: Promise<void>;
}> {
  const directory = await fixture();
  const runtime = join(directory, 'runtime');
  const socket = join(runtime, 'broker.sock');
  const descriptor = join(directory, 'descriptor.json');
  const generation = randomUUID();
  const capability = randomUUID();
  const engine = new BrokerFixtureEngine(generation, binary);
  await writeFile(descriptor, `${JSON.stringify({
    version: 1,
    protocol: 1,
    generation,
    capability,
    serverInstanceId: randomUUID(),
    socketPath: socket,
    runtimeDirectory: runtime,
    operationJournalPath: join(directory, 'journal.json'),
    fileFavoritesPath: join(directory, 'favorites.json'),
    uid: process.getuid?.() ?? 0,
    programDigest: 'a'.repeat(64)
  })}\n`, { mode: 0o600 });
  await chmod(descriptor, 0o600);
  const broker = runHostBroker(descriptor, () => engine);
  await waitFor(async () => (await lstat(socket).catch(() => undefined))?.isSocket() === true);
  const backend = await HostBrokerBackend.connect(async () => ({ socketPath: socket, generation, capability }));
  return { backend, engine, broker };
}

describe('host files broker protocol', () => {
  // preserve arbitrary bytes across fragmented and coalesced frames
  it('decodes NUL and non-UTF8 binary frames across arbitrary chunks', async () => {
    const first = encodeBrokerFrame(BrokerFrameKind.Binary, Buffer.from([0, 0xff, 1]));
    const second = encodeBrokerFrame(BrokerFrameKind.Binary, Buffer.from([0xfe, 2, 0]));
    const bytes = Buffer.concat([first, second]);
    const frames = decodeBrokerFrames(Readable.from([bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)]));
    const payloads: Buffer[] = [];
    // collect the two decoded fixture frames
    for await (const frame of frames) payloads.push(frame.payload);
    expect(Buffer.concat(payloads)).toEqual(Buffer.from([0, 0xff, 1, 0xfe, 2, 0]));
  });

  // reject impossible frame allocation before payload buffering
  it('rejects an oversized declared binary frame', async () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(BrokerFrameKind.Binary, 0);
    header.writeUInt32BE(64 * 1024 + 1, 1);
    const read = async () => {
      // force the generator to inspect its first header
      for await (const _frame of decodeBrokerFrames(Readable.from([header]))) { /* no valid frame */ }
    };
    await expect(read()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  // leave room for paired bounded manifests while rejecting larger control allocation
  it('accepts multi-megabyte control metadata and rejects control frames above 8 MiB', async () => {
    const accepted = encodeBrokerFrame(BrokerFrameKind.Control, Buffer.alloc(3 * 1024 * 1024));
    expect(accepted.length).toBe(3 * 1024 * 1024 + 5);
    expect(() => encodeBrokerFrame(BrokerFrameKind.Control, Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1))).toThrowError(/exceeds limit/u);
    const header = Buffer.alloc(5);
    header.writeUInt8(BrokerFrameKind.Control, 0);
    header.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 1);
    const read = async () => {
      // force declared-length validation without buffering the body
      for await (const _frame of decodeBrokerFrames(Readable.from([header]))) { /* no valid frame */ }
    };
    await expect(read()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  // execute the fixed two-hop launcher with hostile path characters
  it('keeps configured launcher paths literal through both exec steps', async () => {
    const root = await fixture();
    const directory = join(root, `space ' $x ; [glob] ü`);
    await mkdir(directory);
    const executable = join(directory, `node '$; fake`);
    const program = join(directory, 'broker ` program.js');
    const descriptor = join(directory, 'descriptor * value.json');
    const output = join(directory, 'argv.json');
    await writeFile(executable, `#!/bin/sh\nprintf '%s' "$1" > "$TEST_ARGV_ONE"\nprintf '%s' "$2" > "$TEST_ARGV_TWO"\n`, { mode: 0o700 });
    const launcher = join(directory, `launcher ' $ ;.sh`);
    await writeFile(launcher, renderHostBrokerLauncher(executable, program, descriptor), { mode: 0o700 });
    await execute('/bin/sh', ['-c', `exec ${posixShellLiteral(launcher)}`], { env: { ...process.env, TEST_ARGV_ONE: output, TEST_ARGV_TWO: `${output}.two` } });
    expect(await readFile(output, 'utf8')).toBe(program);
    expect(await readFile(`${output}.two`, 'utf8')).toBe(descriptor);
  });

  // round-trip exact file bytes without tmux text channels
  it('streams binary downloads and uploads over the private socket', async () => {
    const expected = Buffer.concat(Array.from({ length: 64 }, (_value, index) => Buffer.from([0, 0xff, index, 0xfe])));
    const { backend, engine, broker } = await brokerFixture(expected);
    const result = await backend.request({ kind: 'inspect', path: '/fixture' });
    expect(result.path).toBe('/fixture');
    const downloaded: Buffer[] = [];
    // consume the exact binary download
    for await (const chunk of await backend.read({ kind: 'read', path: '/fixture' })) downloaded.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(downloaded)).toEqual(expected);
    const parent = { ...identity(), kind: 'directory' as const };
    const uploaded = Buffer.concat(Array.from({ length: 128 }, (_value, index) => Buffer.from([index, 0, 0xff])));
    const write = await backend.write({ kind: 'write', operationId: 'upload-operation-1', path: '/upload', size: uploaded.length, destinationParentIdentity: parent, replace: false }, Readable.from([uploaded]));
    expect(write.bytesWritten).toBe(uploaded.length);
    expect(Buffer.concat(engine.uploads)).toEqual(uploaded);
    await backend.close();
    await broker;
  });

  // bind every controller and operation to one capability generation
  it('rejects duplicate controllers, wrong capabilities, and unknown commands', async () => {
    const directory = await fixture();
    const runtime = join(directory, 'runtime');
    const socket = join(runtime, 'broker.sock');
    const descriptor = join(directory, 'descriptor.json');
    const generation = randomUUID();
    const capability = randomUUID();
    const engine = new BrokerFixtureEngine(generation, Buffer.from('fixture'));
    await writeFile(descriptor, `${JSON.stringify({
      version: 1, protocol: 1, generation, capability, serverInstanceId: randomUUID(), socketPath: socket,
      runtimeDirectory: runtime, operationJournalPath: join(directory, 'journal.json'), fileFavoritesPath: join(directory, 'favorites.json'),
      uid: process.getuid?.() ?? 0, programDigest: 'c'.repeat(64)
    })}\n`, { mode: 0o600 });
    const broker = runHostBroker(descriptor, () => engine);
    await waitFor(async () => (await lstat(socket).catch(() => undefined))?.isSocket() === true);
    const backend = await HostBrokerBackend.connect(async () => ({ socketPath: socket, generation, capability }));
    await expect(HostBrokerBackend.connect(async () => ({ socketPath: socket, generation, capability }))).rejects.toMatchObject({ code: 'broker_busy' });
    await expect(HostBrokerBackend.connect(async () => ({ socketPath: socket, generation, capability: 'wrong-capability' }))).rejects.toMatchObject({ code: 'bridge_unavailable' });
    await expect(backend.request({ kind: 'shell', command: 'id' } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(backend.request({ kind: 'inspect', path: '/limit' })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(backend.request({ kind: 'inspect', path: '/favorite-replaced' })).rejects.toMatchObject({ code: 'favorite_replaced', statusCode: 409 });
    expect((await backend.request({ kind: 'inspect', path: '/still-ready' })).path).toBe('/still-ready');
    expect(backend.generation()).toBe(generation);
    await backend.close();
    await broker;
  });

  // keep a fast upload producer bounded behind a slow host consumer
  it('propagates upload backpressure before cancellation', async () => {
    const { backend, engine, broker } = await brokerFixture();
    const abort = new AbortController();
    let produced = 0;
    const source = Readable.from((async function* () {
      // expose producer progress under socket pressure
      for (let index = 0; index < 1024; index += 1) {
        produced += 1;
        yield Buffer.alloc(64 * 1024, index);
      }
    })());
    const parent = { ...identity(), kind: 'directory' as const };
    const pending = backend.write({
      kind: 'write', operationId: 'backpressure-operation', path: '/slow-upload', size: 64 * 1024 * 1024,
      destinationParentIdentity: parent, replace: false
    }, source, abort.signal);
    const settled = pending.catch(error => error as Error);
    await waitFor(() => engine.uploads.length > 0);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(produced).toBeLessThan(1024);
    abort.abort(new Error('backpressure probe complete'));
    expect(await settled).toBeInstanceOf(Error);
    await backend.close();
    await broker;
  }, 15_000);

  // exercise the real builtin engine against an arbitrary host path
  it('runs real outside-checkout binary I/O and cleans a disconnected upload', async () => {
    const directory = await fixture();
    const runtime = join(directory, 'runtime');
    const socket = join(runtime, 'broker.sock');
    const descriptor = join(directory, 'descriptor.json');
    const generation = randomUUID();
    const capability = randomUUID();
    const source = join(directory, 'outside.bin');
    const destination = join(directory, 'uploaded.bin');
    const canceled = join(directory, 'canceled.bin');
    const contents = Buffer.concat([Buffer.from([0, 0xff, 0xfe]), Buffer.alloc(256 * 1024, 0x5a)]);
    await writeFile(source, contents);
    await writeFile(descriptor, `${JSON.stringify({
      version: 1,
      protocol: 1,
      generation,
      capability,
      serverInstanceId: randomUUID(),
      socketPath: socket,
      runtimeDirectory: runtime,
      operationJournalPath: join(directory, 'journal.json'),
      fileFavoritesPath: join(directory, 'favorites.json'),
      uid: process.getuid?.() ?? 0,
      programDigest: 'b'.repeat(64)
    })}\n`, { mode: 0o600 });
    const broker = runHostBroker(descriptor);
    await waitFor(async () => (await lstat(socket).catch(() => undefined))?.isSocket() === true);
    const backend = await HostBrokerBackend.connect(async () => ({ socketPath: socket, generation, capability }));
    const inspected = await backend.request({ kind: 'inspect', path: source });
    const downloaded: Buffer[] = [];
    // read the exact prepared inode through the broker
    for await (const chunk of await backend.read({ kind: 'read', path: source, identity: inspected })) downloaded.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(downloaded)).toEqual(contents);
    const parent = await backend.request({ kind: 'inspect', path: directory });
    const uploaded = await backend.write({
      kind: 'write', operationId: 'actual-upload-operation', path: destination, size: contents.length,
      destinationParentIdentity: parent, replace: false
    }, Readable.from([contents]));
    expect(uploaded.bytesWritten).toBe(contents.length);
    expect(await readFile(destination)).toEqual(contents);
    const refreshedParent = await backend.request({ kind: 'inspect', path: directory });
    const abort = new AbortController();
    const slowSource = Readable.from((async function* () {
      // keep the real staged upload active until cancellation
      for (let index = 0; index < 1024; index += 1) {
        yield Buffer.alloc(64 * 1024, index);
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    })());
    const pending = backend.write({
      kind: 'write', operationId: 'canceled-upload-operation', path: canceled, size: 64 * 1024 * 1024,
      destinationParentIdentity: refreshedParent, replace: false
    }, slowSource, abort.signal);
    const settled = pending.catch(error => error as Error);
    await waitFor(async () => (await readdir(directory)).some(name => name.startsWith('.rac-files-upload-')));
    abort.abort(new Error('test disconnect'));
    expect(await settled).toBeInstanceOf(Error);
    await waitFor(async () => !(await readdir(directory)).some(name => name.startsWith('.rac-files-upload-')));
    expect(await lstat(canceled).catch(() => undefined)).toBeUndefined();
    await backend.close();
    await broker;
  }, 15_000);

  // propagate controller EOF to an actual running engine request
  it('cancels active host work when the controller disconnects', async () => {
    const { backend, engine, broker } = await brokerFixture();
    const request = backend.request({ kind: 'inspect', path: '/pending' });
    await waitFor(() => engine.requestSignals.length === 1);
    await backend.close();
    await expect(request).rejects.toBeInstanceOf(Error);
    expect(engine.requestSignals[0]?.aborted).toBe(true);
    await broker;
  });

  // stop reading host bytes when the consumer disconnects
  it('cancels the host read stream when the consumer disconnects', async () => {
    const expected = Buffer.alloc(16 * 1024 * 1024, 0xa5);
    const { backend, engine, broker } = await brokerFixture(expected);
    const stream = await backend.read({ kind: 'read', path: '/large' });
    await waitFor(() => engine.readStarted);
    stream.destroy();
    await waitFor(() => engine.readDestroyed);
    await backend.close();
    await broker;
  });
});

describe('lazy host broker lifecycle', () => {
  // keep construction side-effect free for existing server startup
  it('does not launch tmux until the first filesystem request', async () => {
    const root = await fixture();
    let calls = 0;
    const backend = new LazyHostBrokerBackend({
      tmuxBinary: '/usr/bin/tmux',
      hostTmuxSocket: '/tmp/tmux.sock',
      hostProcRoot: '/proc',
      serverCheckout: root,
      hostCheckout: root,
      hostNodeBin: process.execPath,
      hostUid: process.getuid?.() ?? 0,
      operationJournalPath: join(root, 'journal.json'),
      fileFavoritesPath: join(root, 'favorites.json'),
      // count every attempted tmux invocation
      commandRunner: async () => { calls += 1; return { code: 1, stdout: '', stderr: '' }; }
    });
    expect(backend.generation()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls).toBe(0);
    await backend.close();
    expect(calls).toBe(0);
  });

  // fail before tmux or filesystem fallback on uid mismatch
  it('fails closed on numeric uid mismatch', async () => {
    const root = await fixture();
    let calls = 0;
    const backend = new LazyHostBrokerBackend({
      tmuxBinary: '/usr/bin/tmux',
      hostTmuxSocket: '/tmp/tmux.sock',
      hostProcRoot: '/proc',
      serverCheckout: root,
      hostCheckout: root,
      hostNodeBin: process.execPath,
      hostUid: (process.getuid?.() ?? 0) + 1,
      operationJournalPath: join(root, 'journal.json'),
      fileFavoritesPath: join(root, 'favorites.json'),
      // reject any accidental launch attempt
      commandRunner: async () => { calls += 1; return { code: 1, stdout: '', stderr: '' }; }
    });
    const generation = backend.generation();
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'bridge_unavailable' });
    expect(calls).toBe(0);
    expect(backend.generation()).not.toBe(generation);
    await backend.close();
  });

  // retain startup authority when pane markers are only partially committed
  it('does not clean a partially marked failed launch', async () => {
    const root = await fixture();
    const compiledModuleDirectory = join(root, 'compiled');
    await mkdir(compiledModuleDirectory, { mode: 0o700 });
    await writeFile(join(compiledModuleDirectory, 'broker-main.js'), 'export {};\n', { mode: 0o600 });
    let launched = false;
    let sessionName = '';
    let killCalls = 0;
    const backend = new LazyHostBrokerBackend({
      tmuxBinary: '/usr/bin/tmux',
      hostTmuxSocket: join(root, 'tmux.sock'),
      hostProcRoot: '/proc',
      serverCheckout: root,
      hostCheckout: root,
      hostNodeBin: process.execPath,
      hostUid: process.getuid?.() ?? 0,
      operationJournalPath: join(root, 'journal.json'),
      fileFavoritesPath: join(root, 'favorites.json'),
      startupTimeoutMs: 25,
      shutdownTimeoutMs: 25,
      compiledModuleDirectory,
      commandRunner: async (_command, args) => {
        const operation = args[2];
        // report absence before the deterministic launch
        if (operation === 'has-session' && !launched) {
          const target = args[args.indexOf('-t') + 1]!;
          return { code: 1, stdout: '', stderr: `can't find session: ${target.slice(1)}\n` };
        }
        // expose the launched deterministic session during cleanup
        if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
        // capture the newly launched pane
        if (operation === 'new-session') {
          launched = true;
          sessionName = args[args.indexOf('-s') + 1]!;
          return { code: 0, stdout: '%42\n', stderr: '' };
        }
        // fail after committing only the role marker
        if (operation === 'set-option') {
          return args.includes('@rac_role')
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 1, stdout: '', stderr: 'marker failure' };
        }
        // expose the incomplete marker set
        if (operation === 'display-message') {
          return { code: 0, stdout: `$42\t${sessionName}\t%42\t${process.pid}\t\tfiles-broker\t\t\n`, stderr: '' };
        }
        // record forbidden cleanup signaling
        if (operation === 'kill-session') {
          killCalls += 1;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: '' };
      }
    });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    const dataDirectory = join(root, '.data', 'host-files');
    const ownerPath = join(dataDirectory, 'owner.json');
    const lockPath = join(dataDirectory, 'owner.lock');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { descriptorPath: string; state: string };
    expect(owner.state).toBe('launching');
    expect(await lstat(owner.descriptorPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    expect(killCalls).toBe(0);
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
  });

  // retain shutdown authority when tmux rejects the exact kill
  it('does not clean a ready owner after a failed kill', async () => {
    let killCalls = 0;
    const pane = `$99\t${staleBrokerSession}\t%99\t4242\t${staleBrokerNonce}\tfiles-broker\t${HOST_FILES_PROTOCOL}\t${'a'.repeat(64)}\n`;
    const { backend, descriptorPath, lockPath, ownerPath } = await ownedReadyBrokerFixture(async (_command, args) => {
      const operation = args[2];
      // prove the recorded session remains present
      if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
      // expose the exact persisted pane
      if (operation === 'display-message') return { code: 0, stdout: pane, stderr: '' };
      // reject the exact kill request
      if (operation === 'kill-session') {
        killCalls += 1;
        return { code: 1, stdout: '', stderr: 'kill failed' };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, syntheticProcStat(4242, '12345'));
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
    expect(killCalls).toBe(1);
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
  });

  // retain shutdown authority when proc identity is malformed
  it('does not clean a ready owner after malformed proc inspection', async () => {
    let tmuxCalls = 0;
    const { backend, descriptorPath, lockPath, ownerPath } = await ownedReadyBrokerFixture(async () => {
      tmuxCalls += 1;
      return { code: 1, stdout: '', stderr: '' };
    }, 'malformed proc stat\n');
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
    expect(tmuxCalls).toBe(0);
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
  });

  // retain shutdown authority while the exact process survives the kill
  it('does not clean a ready owner whose process survives kill', async () => {
    let killCalls = 0;
    const pane = `$99\t${staleBrokerSession}\t%99\t4242\t${staleBrokerNonce}\tfiles-broker\t${HOST_FILES_PROTOCOL}\t${'a'.repeat(64)}\n`;
    const { backend, descriptorPath, lockPath, ownerPath } = await ownedReadyBrokerFixture(async (_command, args) => {
      const operation = args[2];
      // prove the recorded session remains present
      if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
      // expose the exact persisted pane
      if (operation === 'display-message') return { code: 0, stdout: pane, stderr: '' };
      // accept signaling without removing the synthetic process
      if (operation === 'kill-session') {
        killCalls += 1;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, syntheticProcStat(4242, '12345'));
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
    expect(killCalls).toBe(1);
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
  });

  // release shutdown authority only after the killed process exits
  it('cleans a ready owner after verified post-kill exit', async () => {
    let procStatPath = '';
    const pane = `$99\t${staleBrokerSession}\t%99\t4242\t${staleBrokerNonce}\tfiles-broker\t${HOST_FILES_PROTOCOL}\t${'a'.repeat(64)}\n`;
    const created = await ownedReadyBrokerFixture(async (_command, args) => {
      const operation = args[2];
      // prove the recorded session remains present
      if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
      // expose the exact persisted pane
      if (operation === 'display-message') return { code: 0, stdout: pane, stderr: '' };
      // remove the synthetic process after accepted signaling
      if (operation === 'kill-session') {
        await rm(procStatPath);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, syntheticProcStat(4242, '12345'));
    procStatPath = created.procStatPath;
    await created.backend.close();
    expect(await lstat(created.descriptorPath).catch(() => undefined)).toBeUndefined();
    expect(await lstat(created.ownerPath).catch(() => undefined)).toBeUndefined();
    expect(await lstat(created.lockPath).catch(() => undefined)).toBeUndefined();
  });

  // recover stale private state when exact tmux lookup proves absence
  it('reconciles a dead ready owner despite blank-success display semantics', async () => {
    const calls: string[][] = [];
    const { backend, descriptorPath, generation, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      calls.push(args);
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // reproduce the mounted tmux behavior for the stale target
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) {
        return { code: 1, stdout: '', stderr: `can't find session: ${staleBrokerSession}\n` };
      }
      // stop after reconciliation before launching a replacement
      if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(calls[0]?.slice(2)).toEqual(['has-session', '-t', `=${staleBrokerSession}`]);
    expect(calls.some(args => args[2] === 'display-message' && args.includes(`=${staleBrokerSession}:`))).toBe(false);
    expect(await lstat(descriptorPath).catch(() => undefined)).toBeUndefined();
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).generation).not.toBe(generation);
    expect(await lstat(lockPath)).toBeDefined();
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
  });

  // retain ready ownership while its exact process survives without tmux
  it('does not clean a sessionless ready owner while its recorded process is live', async () => {
    const ownerPidStartTime = await currentProcessStartTime();
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // prove only the recorded session is absent
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) {
        return { code: 1, stdout: '', stderr: `can't find session: ${staleBrokerSession}` };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, { ownerPidStartTime });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });

  // honor a surviving exact process after signaling its marked session
  it('does not clean a marked ready owner when its process outlives the stop wait', async () => {
    const ownerPidStartTime = await currentProcessStartTime();
    let killed = false;
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // expose one exact marked stale session
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) return { code: 0, stdout: '', stderr: '' };
      // bind the displayed pane to the persisted process identity
      if (operation === 'display-message' && target === `=${staleBrokerSession}:`) {
        return {
          code: 0,
          stdout: `$99\t${staleBrokerSession}\t%99\t${process.pid}\t${staleBrokerNonce}\tfiles-broker\t${HOST_FILES_PROTOCOL}\t${'a'.repeat(64)}\n`,
          stderr: ''
        };
      }
      // record the exact kill without terminating the test process
      if (operation === 'kill-session' && target === '$99') {
        killed = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, { ownerPidStartTime });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(killed).toBe(true);
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });

  // retain ready ownership when recorded process inspection is malformed
  it('does not clean a sessionless ready owner after ambiguous process inspection', async () => {
    const fakeProcRoot = await fixture();
    await mkdir(join(fakeProcRoot, String(process.pid)), { mode: 0o700 });
    await writeFile(join(fakeProcRoot, String(process.pid), 'stat'), 'malformed proc stat\n', { mode: 0o600 });
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // prove only the recorded session is absent
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) {
        return { code: 1, stdout: '', stderr: `can't find session: ${staleBrokerSession}` };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, { hostProcRoot: fakeProcRoot, ownerPidStartTime: '123' });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });

  // retain launching ownership when no process identity was persisted
  it('does not clean a sessionless launching owner without process proof', async () => {
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // prove only the recorded session is absent
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) {
        return { code: 1, stdout: '', stderr: `can't find session: ${staleBrokerSession}` };
      }
      return { code: 1, stdout: '', stderr: '' };
    }, { state: 'launching' });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });

  // recover only when a session disappears during pane inspection
  it('rechecks exact absence after a blank display result', async () => {
    let staleLookups = 0;
    const { backend, descriptorPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // model a session disappearing between lookup and display
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) {
        staleLookups += 1;
        return staleLookups === 1
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: `can't find session: ${staleBrokerSession}` };
      }
      // reproduce the wrapper's misleading blank-success display
      if (operation === 'display-message' && target === `=${staleBrokerSession}:`) return { code: 0, stdout: '\t\n', stderr: '' };
      // stop after reconciliation before launching a replacement
      if (operation === 'has-session') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(staleLookups).toBe(2);
    expect(await lstat(descriptorPath).catch(() => undefined)).toBeUndefined();
    await expect(backend.close()).rejects.toMatchObject({ code: 'broker_busy' });
  });

  // preserve stale state when an ambiguous live session still collides
  it('does not clean a stale owner after blank display while the session remains live', async () => {
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async (_command, args) => {
      const operation = args[2];
      const target = args[args.indexOf('-t') + 1];
      // keep the exact stale target present across both lookups
      if (operation === 'has-session' && target === `=${staleBrokerSession}`) return { code: 0, stdout: '', stderr: '' };
      // reproduce the wrapper's ambiguous blank-success response
      if (operation === 'display-message' && target === `=${staleBrokerSession}:`) return { code: 0, stdout: '\t\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });

  // preserve stale state when tmux cannot prove absence
  it('does not clean a stale owner after an ambiguous lookup failure', async () => {
    const { backend, descriptorPath, lockPath, ownerPath } = await staleBrokerFixture(async () => ({
      code: 1,
      stdout: '',
      stderr: 'error connecting to tmux socket'
    }));
    await expect(backend.request({ kind: 'inspect', path: '/tmp' })).rejects.toMatchObject({ code: 'broker_busy' });
    expect(await lstat(descriptorPath)).toBeDefined();
    expect(await lstat(ownerPath)).toBeDefined();
    expect(await lstat(lockPath)).toBeDefined();
    await backend.close();
  });
});
