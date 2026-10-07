import { basename, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { HostFilesError, type HostFilesBackend, type HostFilesTreeEntry, type HostFilesTreeManifest } from './contracts.js';

export type HostFilesZipSelection = { root: string; manifest: HostFilesTreeManifest };
type CentralEntry = { name: Buffer; crc: number; size: number; offset: number; externalAttributes: number; modifiedAt: number };

const utf8DataDescriptorFlags = 0x0808;
const zipVersion = 20;
const unixZipVersion = (3 << 8) | zipVersion;

// build the fixed crc-32 lookup table once
function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  // derive every byte transition
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    // fold all eight bits
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}
const crcLookup = crcTable();

// update one incremental crc-32 state
function updateCrc(state: number, bytes: Uint8Array): number {
  let value = state;
  // consume the current stream chunk only
  for (const byte of bytes) value = crcLookup[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

// convert one timestamp into legacy DOS date/time fields
function dosTime(timestamp: number): { date: number; time: number } {
  const date = new Date(timestamp);
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

// build one store-method local header with a trailing data descriptor
function localHeader(name: Buffer, timestamp: number): Buffer {
  const time = dosTime(timestamp);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(zipVersion, 4);
  header.writeUInt16LE(utf8DataDescriptorFlags, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time.time, 10);
  header.writeUInt16LE(time.date, 12);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

// build one data descriptor after streamed entry bytes
function descriptor(crc: number, size: number): Buffer {
  const value = Buffer.alloc(16);
  value.writeUInt32LE(0x08074b50, 0);
  value.writeUInt32LE(crc >>> 0, 4);
  value.writeUInt32LE(size, 8);
  value.writeUInt32LE(size, 12);
  return value;
}

// build one bounded central-directory record
function centralHeader(entry: CentralEntry): Buffer {
  const time = dosTime(entry.modifiedAt);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(unixZipVersion, 4);
  header.writeUInt16LE(zipVersion, 6);
  header.writeUInt16LE(utf8DataDescriptorFlags, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time.time, 12);
  header.writeUInt16LE(time.date, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.externalAttributes >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

// build the non-ZIP64 end-of-central-directory record
function endRecord(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  return record;
}

// map one selected object into a safe relative archive name
function archiveName(root: string, entry: HostFilesTreeEntry): string {
  const suffix = relative(root, entry.path).split(sep).join('/');
  const top = basename(root) || 'root';
  const combined = suffix === '' ? top : `${top}/${suffix}`;
  const normalized = entry.identity.kind === 'directory' && !combined.endsWith('/') ? `${combined}/` : combined;
  // reject names that could escape during extraction
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) throw new HostFilesError('invalid_path', 'unsafe archive path', 400);
  return normalized;
}

// compare one frozen ZIP identity with fresh backend metadata
function sameIdentity(left: HostFilesTreeEntry['identity'], right: HostFilesTreeEntry['identity']): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
    && left.size === right.size && left.nlink === right.nlink && left.kind === right.kind;
}

// preflight all non-ZIP64 names, sizes, duplicates and central offsets
export function preflightZipSelections(selections: readonly HostFilesZipSelection[]): void {
  const names = new Set<string>();
  let offset = 0;
  let count = 0;
  // calculate every local record before response headers
  for (const selection of selections) {
    // inspect only frozen metadata
    for (const entry of selection.manifest.entries) {
      const name = archiveName(selection.root, entry);
      const encoded = Buffer.byteLength(name);
      const size = entry.identity.kind === 'file' ? Number(entry.identity.size) : entry.identity.kind === 'symlink' ? Buffer.byteLength(entry.linkTarget ?? '') : 0;
      // reject special objects and ZIP64 inputs
      if (!['file', 'directory', 'symlink'].includes(entry.identity.kind)) throw new HostFilesError('unsupported_type', 'object type cannot be archived', 422);
      if (encoded > 0xffff || !Number.isSafeInteger(size) || size > 0xffffffff) throw new HostFilesError('limit_exceeded', 'archive entry exceeds ZIP limits', 413);
      // reject duplicate archive names before streaming
      if (names.has(name)) throw new HostFilesError('conflict', 'duplicate archive entry', 409);
      names.add(name);
      offset += 30 + encoded + size + 16;
      count += 1;
      // reject central offsets and entry counts requiring ZIP64
      if (offset > 0xffffffff || count > 10_000 || count > 0xffff) throw new HostFilesError('limit_exceeded', 'archive exceeds ZIP limits', 413);
    }
  }
  const centralSize = [...names].reduce((total, name) => total + 46 + Buffer.byteLength(name), 0);
  // include the central directory and end record in the offset bound
  if (offset + centralSize + 22 > 0xffffffff) throw new HostFilesError('limit_exceeded', 'archive exceeds ZIP limits', 413);
}

// stream one complete store-method ZIP with bounded central metadata
async function* generateZip(backend: HostFilesBackend, selections: readonly HostFilesZipSelection[], signal?: AbortSignal): AsyncGenerator<Buffer> {
  const central: CentralEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  // emit every frozen manifest entry without following links
  for (const selection of selections) {
    // retain deterministic parent-before-child order
    for (const entry of selection.manifest.entries) {
      // stop the actual backend stream after a disconnect
      if (signal?.aborted) throw new HostFilesError('partial_failure', 'archive canceled', 409);
      const name = archiveName(selection.root, entry);
      // reject duplicate archive names before headers
      if (names.has(name)) throw new HostFilesError('conflict', 'duplicate archive entry', 409);
      names.add(name);
      const encodedName = Buffer.from(name, 'utf8');
      const modifiedAt = Number(BigInt(entry.identity.mtimeNs) / 1_000_000n);
      const headerOffset = offset;
      const header = localHeader(encodedName, modifiedAt);
      yield header;
      offset += header.length;
      let crc = 0xffffffff;
      let size = 0;
      // revalidate directory and link entries immediately before encoding metadata
      if (entry.identity.kind !== 'file') {
        const current = await backend.request({ kind: 'inspect', path: entry.path });
        if (!sameIdentity(entry.identity, current)) throw new HostFilesError('stale_object', 'archive source changed', 409);
      }
      // stream regular file bytes through the ZIP response
      if (entry.identity.kind === 'file') {
        const source = await backend.read({ kind: 'read', path: entry.path, identity: entry.identity }, signal);
        // preserve source backpressure while calculating metadata
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          crc = updateCrc(crc, bytes);
          size += bytes.length;
          // reject inputs requiring ZIP64
          if (size > 0xffffffff) throw new HostFilesError('limit_exceeded', 'archive entry exceeds ZIP limits', 413);
          yield bytes;
          offset += bytes.length;
        }
        const current = await backend.request({ kind: 'inspect', path: entry.path });
        // fail the stream when a file changed or truncated after open
        if (size !== Number(entry.identity.size) || !sameIdentity(entry.identity, current)) throw new HostFilesError('stale_object', 'archive source changed', 409);
      // encode symlink text as inert entry data
      } else if (entry.identity.kind === 'symlink') {
        const bytes = Buffer.from(entry.linkTarget ?? '', 'utf8');
        crc = updateCrc(crc, bytes);
        size = bytes.length;
        yield bytes;
        offset += bytes.length;
      // directories carry no data
      } else if (entry.identity.kind !== 'directory') {
        throw new HostFilesError('unsupported_type', 'object type cannot be archived', 422);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const trailer = descriptor(crc, size);
      yield trailer;
      offset += trailer.length;
      const unixMode = entry.identity.kind === 'symlink' ? 0o120777 : entry.identity.kind === 'directory' ? 0o040755 : 0o100644;
      central.push({ name: encodedName, crc, size, offset: headerOffset, externalAttributes: (unixMode << 16) >>> 0, modifiedAt });
    }
  }
  const centralOffset = offset;
  // emit the bounded central directory
  for (const entry of central) {
    const header = centralHeader(entry);
    yield header;
    offset += header.length;
  }
  const centralSize = offset - centralOffset;
  yield endRecord(central.length, centralSize, centralOffset);
}

// create one backpressure-aware ZIP stream
export function createZipStream(backend: HostFilesBackend, selections: readonly HostFilesZipSelection[], signal?: AbortSignal): Readable {
  preflightZipSelections(selections);
  return Readable.from(generateZip(backend, selections, signal));
}
