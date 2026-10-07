import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { HostFilesService } from '../src/host-files/service.js';
import { createZipStream } from '../src/host-files/zip.js';
import type { HostFilesBackend } from '../src/host-files/contracts.js';

const fixtures: Array<{ root: string; backend: HostFilesBackend }> = [];

afterEach(async () => {
  // close stream engines before removing disposable roots
  for (const fixture of fixtures.splice(0)) { await fixture.backend.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

// collect one stream only in bounded test fixtures
async function bytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  // retain exact binary chunks
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

type ParsedEntry = { name: string; data: Buffer; externalAttributes: number };

// parse store-method entries from the generated central directory
function parseZip(archive: Buffer): ParsedEntry[] {
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(end + 10);
  let central = archive.readUInt32LE(end + 16);
  const entries: ParsedEntry[] = [];
  // follow each central record back to its local data
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(central)).toBe(0x02014b50);
    const size = archive.readUInt32LE(central + 24);
    const nameLength = archive.readUInt16LE(central + 28);
    const extraLength = archive.readUInt16LE(central + 30);
    const commentLength = archive.readUInt16LE(central + 32);
    const externalAttributes = archive.readUInt32LE(central + 38);
    const local = archive.readUInt32LE(central + 42);
    const name = archive.subarray(central + 46, central + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: archive.subarray(start, start + size), externalAttributes });
    central += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('host Files ZIP streams', () => {
  // retain binary bytes until a delayed response consumer starts reading
  it.each(['file', 'directory'] as const)('retains a delayed %s download without draining it', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'rac-files-delayed-download-'));
    const selected = join(root, 'selected');
    const expected = Buffer.from([0, 255, 17, 128, 104, 101, 108, 108, 111]);
    // provide either raw bytes or one archived folder
    if (kind === 'directory') await mkdir(selected);
    await writeFile(kind === 'file' ? selected : join(selected, 'payload.bin'), expected);
    const backend = createHostFilesEngine('delayed-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
    fixtures.push({ root, backend });
    const service = new HostFilesService({ backend, tokenSecret: 'delayed-download-secret' });
    const place = { id: 'delayed-place', home: root };
    const session = { id: 'delayed-session' };
    const listed = await service.list(place, session);
    const prepared = await service.prepareDownload(place, session, [listed.entries[0]!.objectToken]);
    const opened = await service.openDownload(session, prepared.downloadId);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.downloadStatus(place, session, prepared.downloadId).state).toBe('streaming');
    const received = await bytes(opened.stream);
    expect(kind === 'file' ? received : parseZip(received).find(entry => entry.name === 'selected/payload.bin')?.data).toEqual(expected);
    expect(service.downloadStatus(place, session, prepared.downloadId)).toEqual({ state: 'completed', bytesCompleted: received.length });
    await service.close();
  });

  // encode nested binary files, empty directories and inert symlink text
  it('streams a portable store-method ZIP without following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-files-zip-'));
    const selected = join(root, 'selected');
    await mkdir(selected); await mkdir(join(selected, 'empty'));
    await writeFile(join(selected, 'binary.bin'), Buffer.from([0, 255, 17, 128]));
    await writeFile(join(root, 'secret.txt'), 'must not enter archive');
    await symlink('../secret.txt', join(selected, 'link'));
    const backend = createHostFilesEngine('zip-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
    fixtures.push({ root, backend });
    const manifest = await backend.request({ kind: 'snapshot', path: selected, maxEntries: 100, maxBytes: 1_000 });
    const archive = await bytes(createZipStream(backend, [{ root: selected, manifest }]));
    const entries = parseZip(archive);
    expect(entries.map(entry => entry.name)).toEqual(['selected/', 'selected/binary.bin', 'selected/empty/', 'selected/link']);
    expect(entries.find(entry => entry.name.endsWith('binary.bin'))?.data).toEqual(Buffer.from([0, 255, 17, 128]));
    expect(entries.find(entry => entry.name.endsWith('/link'))?.data.toString('utf8')).toBe('../secret.txt');
    expect(archive.includes(Buffer.from('must not enter archive'))).toBe(false);
    expect((entries.find(entry => entry.name.endsWith('/link'))!.externalAttributes >>> 16) & 0o170000).toBe(0o120000);
  });

  // fail preflight before headers for unsupported visible objects
  it('rejects special objects before creating a ZIP stream', async () => {
    const backend = createHostFilesEngine('zip-special');
    const manifest = { root: '/tmp/device', totalBytes: 0, entries: [{ path: '/tmp/device', identity: { dev: '1', ino: '2', ctimeNs: '3', mtimeNs: '4', size: '0', nlink: '1', kind: 'fifo' as const } }] };
    expect(() => createZipStream(backend, [{ root: manifest.root, manifest }])).toThrowError(expect.objectContaining({ code: 'unsupported_type' }));
    await backend.close();
  });
});
