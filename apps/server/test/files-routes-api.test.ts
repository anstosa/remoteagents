import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { HostFilesService } from '../src/host-files/service.js';
import type { Place } from '../src/places/places.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';

const fixtures: Array<{ root: string; app: FastifyInstance }> = [];
// close every registered backend before deleting only the disposable test roots
afterEach(async () => {
  // dispose all fixture apps even after failed assertions
  for (const fixture of fixtures.splice(0)) { await fixture.app.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

// bind a Place id to the existing route prefix
const url = (placeId: string, suffix: string) => `/api/worktrees/${encodeURIComponent(placeId)}${suffix}`;

// build the real HTTP/auth boundary with only discovery and filesystem roots injected
async function start() {
  const root = await mkdtemp(join(tmpdir(), 'rac-files-api-'));
  const home = join(root, 'host-home'); const outside = join(root, 'outside');
  await mkdir(home); await mkdir(outside);
  await writeFile(join(home, '.hidden'), 'hidden'); await writeFile(join(outside, 'outside.txt'), 'outside preview');
  const worktree = testWorktree({ id: 'proj:/container/place', path: '/container/place', hostPath: home });
  const places: Place[] = [
    { id: 'directory:/container/place', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/container/place', hostPath: home },
    { id: 'scratch:/container/place', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: '/container/place', hostPath: home }
  ];
  const service = new HostFilesService({ backend: createHostFilesEngine('api-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') }), tokenSecret: 'api-fixture-token-secret-long-enough' });
  const app = await buildApp(testConfig({ projects: [testProject({ path: '/container/place', hostPath: home })] }), {
    auth: await testAuthService(), hostFiles: service,
    discovery: { worktreesNow: () => [worktree], place: async (id: string) => places.find(place => place.id === id), dashboard: async () => ({ generation: 1, agents: [], adapters: {}, projects: [], places: [] }), target: async () => undefined } as never,
    dashboardUpdates: { setLoader: () => {}, refresh: async () => undefined, close: () => {} } as never,
    tmux: {} as never,
    launch: { agentHome: () => root, launchResolutions: async () => new Map() } as never
  });
  fixtures.push({ root, app });
  return { root, home, outside, app, worktree, places, headers: await authenticatedHeaders(app) };
}

// poll a prepared operation only until its deterministic native job reaches terminal state
async function terminal(app: FastifyInstance, placeId: string, operationId: string, headers: Record<string, string>) {
  // bound test polling without changing any user-question behavior
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: url(placeId, `/files/operations/${operationId}`), headers });
    expect(response.statusCode).toBe(200);
    const operation = response.json().operation;
    // return the first immutable terminal result
    if (['completed', 'partial', 'failed', 'canceled'].includes(operation.state)) return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('fixture operation did not finish');
}

// test the actual buildApp route registration and existing operator-control boundary
describe('Files Place routes', () => {
  // every Place starts at its host-side home without requiring a git checkout
  it('lists Worktree, directory and Scratch host homes including hidden metadata', async () => {
    const f = await start();
    // exercise each supported Place through current discovery resolution
    for (const id of [f.worktree.id, ...f.places.map(place => place.id)]) {
      const response = await f.app.inject({ method: 'POST', url: url(id, '/files/list'), headers: f.headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ path: f.home, destinationDirectoryToken: expect.any(String), directoryEntry: { name: 'host-home', hostPath: f.home, kind: 'directory', objectToken: expect.any(String), owner: { uid: expect.any(Number), label: expect.any(String) }, permissions: expect.any(String), modifiedAt: expect.any(String), size: expect.any(Number) }, entries: [expect.objectContaining({ name: '.hidden', owner: { uid: expect.any(Number), label: expect.any(String) }, permissions: expect.any(String), modifiedAt: expect.any(String), size: 6 })] });
      expect(response.json().directoryEntry.objectToken).not.toBe(response.json().destinationDirectoryToken);
    }
  });

  // bind current-directory favorites and downloads to object capabilities rather than destination authority
  it('favorites and downloads the current directory with separate purpose-bound tokens', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const { directoryEntry, destinationDirectoryToken } = listed.json();
    const wrongPurpose = await f.app.inject({ method: 'PUT', url: url(f.worktree.id, '/file-favorites'), headers: f.headers, payload: { objectToken: destinationDirectoryToken } });
    expect(wrongPurpose.statusCode).toBe(409);
    const favorite = await f.app.inject({ method: 'PUT', url: url(f.worktree.id, '/file-favorites'), headers: f.headers, payload: { objectToken: directoryEntry.objectToken } });
    expect(favorite.statusCode).toBe(200);
    expect(favorite.json().favorite).toMatchObject({ path: f.outside, entry: { kind: 'directory' } });
    const refreshed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    expect(refreshed.json().directoryEntry.favorite).toMatchObject({ id: favorite.json().favorite.id, state: 'available' });
    const other = await f.app.inject({ method: 'GET', url: url(f.places[0]!.id, '/file-favorites'), headers: f.headers });
    expect(other.json().favorites).toEqual([]);
    const prepared = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/downloads'), headers: f.headers, payload: { objectTokens: [directoryEntry.objectToken] } });
    expect(prepared.statusCode).toBe(200);
    const download = await f.app.inject({ method: 'GET', url: prepared.json().url, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const removed = await f.app.inject({ method: 'DELETE', url: url(f.worktree.id, `/file-favorites/${favorite.json().favorite.id}`), headers: f.headers });
    expect(removed.statusCode).toBe(204);
    const favorites = await f.app.inject({ method: 'GET', url: url(f.worktree.id, '/file-favorites'), headers: f.headers });
    expect(favorites.json().favorites).toEqual([]);
  });

  // preserve row identity when a folder menu resolves destination authority
  it('exchanges only matching current folder capabilities through the scoped list route', async () => {
    const f = await start(); const folder = join(f.home, 'folder'); await mkdir(folder);
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: {} });
    const objectToken = listed.json().entries.find((entry: { name: string }) => entry.name === 'folder').objectToken;
    const scoped = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: folder, objectToken } });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({ path: folder, destinationDirectoryToken: expect.any(String) });
    const mismatch = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside, objectToken } });
    expect(mismatch.statusCode).toBe(400);
    const otherPlace = await f.app.inject({ method: 'POST', url: url(f.places[0]!.id, '/files/list'), headers: f.headers, payload: { path: folder, objectToken } });
    expect(otherPlace.statusCode).toBe(409);
    await rename(folder, join(f.home, 'old-folder')); await mkdir(folder);
    const replaced = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: folder, objectToken } });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error.code).toBe('stale_object');
    expect(await readdir(folder)).toEqual([]);
  });

  // full-host previews are separate from the still-contained legacy preview route
  it('navigates and previews outside a Place without relaxing agent file previews', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    expect(listed.statusCode).toBe(200);
    const token = listed.json().entries[0].objectToken;
    const preview = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/preview'), headers: f.headers, payload: { objectToken: token } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ binary: false, content: 'outside preview' });
    const legacy = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/file-preview'), headers: f.headers, payload: { path: f.outside } });
    expect(legacy.statusCode).not.toBe(200);
  });

  // mutating and read-like POST endpoints both require Origin and CSRF protection
  it('rejects missing session, foreign Host, foreign Origin and missing CSRF', async () => {
    const f = await start(); const route = url(f.worktree.id, '/files/list');
    const anonymous = await f.app.inject({ method: 'POST', url: route, headers: { host: testHost, origin: f.headers.origin }, payload: {} });
    expect(anonymous.statusCode).toBe(401);
    const foreignHost = await f.app.inject({ method: 'POST', url: route, headers: { ...f.headers, host: 'foreign.example.com' }, payload: {} });
    expect(foreignHost.statusCode).toBe(403);
    const foreignOrigin = await f.app.inject({ method: 'POST', url: route, headers: { ...f.headers, origin: 'https://foreign.example.com' }, payload: {} });
    expect(foreignOrigin.statusCode).toBe(403);
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = f.headers;
    const noCsrf = await f.app.inject({ method: 'POST', url: route, headers: withoutCsrf, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });

  // raw paths never substitute for a destination directory capability
  it('rejects missing parent tokens and unknown destination fields before mutation', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: {} });
    const missing = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'create-file', name: 'new' } });
    expect(missing.statusCode).toBe(400);
    const raw = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'create-file', name: 'new', destinationDirectoryToken: listed.json().destinationDirectoryToken, destinationPath: join(f.outside, 'new') } });
    expect(raw.statusCode).toBe(400);
    expect(await readdir(f.home)).toEqual(['.hidden']);
    expect(await readdir(f.outside)).toEqual(['outside.txt']);
  });

  // confirmation is mandatory and the execute request uses only a stored manifest id
  it('creates and permanently deletes an outside-root file only after confirmation', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const prepared = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'create-file', name: 'new.txt', destinationDirectoryToken: listed.json().destinationDirectoryToken } });
    expect(prepared.statusCode).toBe(200);
    const operationId = prepared.json().operationId;
    const execute = await f.app.inject({ method: 'POST', url: url(f.worktree.id, `/files/operations/${operationId}/execute`), headers: f.headers, payload: { decisions: {} } });
    expect(execute.statusCode).toBe(202);
    expect((await terminal(f.app, f.worktree.id, operationId, f.headers)).state).toBe('completed');
    const refreshed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const objectToken = refreshed.json().entries.find((entry: { name: string }) => entry.name === 'new.txt').objectToken;
    const deletion = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'delete', sourceTokens: [objectToken] } });
    const deleteId = deletion.json().operationId;
    const unconfirmed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, `/files/operations/${deleteId}/execute`), headers: f.headers, payload: { decisions: {} } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await readFile(join(f.outside, 'new.txt'))).toEqual(Buffer.alloc(0));
    const confirmed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, `/files/operations/${deleteId}/execute`), headers: f.headers, payload: { decisions: {}, confirmed: true } });
    expect(confirmed.statusCode).toBe(202);
    expect((await terminal(f.app, f.worktree.id, deleteId, f.headers)).state).toBe('completed');
    expect(await readdir(f.outside)).toEqual(['outside.txt']);
  });

  // persist favorites by exact Place and consume one-use download tickets
  it('isolates favorites and downloads exact bytes through authenticated tickets', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const objectToken = listed.json().entries[0].objectToken;
    const favorite = await f.app.inject({ method: 'PUT', url: url(f.worktree.id, '/file-favorites'), headers: f.headers, payload: { objectToken } });
    expect(favorite.statusCode).toBe(200);
    const other = await f.app.inject({ method: 'GET', url: url(f.places[0]!.id, '/file-favorites'), headers: f.headers });
    expect(other.json().favorites).toEqual([]);
    const prepared = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/downloads'), headers: f.headers, payload: { objectTokens: [objectToken] } });
    expect(prepared.statusCode).toBe(200);
    const downloadUrl = prepared.json().url;
    expect(downloadUrl).not.toContain(f.outside);
    const download = await f.app.inject({ method: 'GET', url: downloadUrl, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(Buffer.from('outside preview'));
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    const replay = await f.app.inject({ method: 'GET', url: downloadUrl, headers: f.headers });
    expect(replay.statusCode).not.toBe(200);
  });

  // raw upload uses a separate parser without increasing the JSON body limit
  it('streams raw binary upload bytes above the global JSON limit', async () => {
    const f = await start(); const binary = Buffer.alloc(70_000, 0xff); binary[0] = 0;
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const prepared = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/uploads/prepare'), headers: f.headers, payload: { destinationDirectoryToken: listed.json().destinationDirectoryToken, files: [{ clientId: 'file-0', name: 'raw.bin', size: binary.length }] } });
    expect(prepared.statusCode).toBe(200);
    const uploadId = prepared.json().uploadId;
    const authorized = await f.app.inject({ method: 'POST', url: url(f.worktree.id, `/files/uploads/${uploadId}/authorize`), headers: f.headers, payload: { decisions: {} } });
    expect(authorized.statusCode).toBe(200);
    const upload = await f.app.inject({ method: 'PUT', url: url(f.worktree.id, `/files/uploads/${uploadId}/file-0`), headers: { ...f.headers, 'content-type': 'application/octet-stream', 'x-files-upload-token': authorized.json().files[0].token }, payload: binary });
    expect(upload.statusCode).toBe(200);
    expect(await readFile(join(f.outside, 'raw.bin'))).toEqual(binary);
    const oversizedJson = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: 'x'.repeat(70_000) } });
    expect(oversizedJson.statusCode).toBe(413);
  });

  // execution cannot refresh away the original destination capability's freshness
  it('rejects parent drift after prepare before any staging write', async () => {
    const f = await start();
    const listed = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const prepared = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'create-file', name: 'new', destinationDirectoryToken: listed.json().destinationDirectoryToken } });
    expect(prepared.statusCode).toBe(200);
    await writeFile(join(f.outside, 'outside-change'), 'outside');
    const execute = await f.app.inject({ method: 'POST', url: url(f.worktree.id, `/files/operations/${prepared.json().operationId}/execute`), headers: f.headers, payload: { decisions: {} } });
    expect(execute.statusCode).toBe(409);
    expect((await readdir(f.outside)).sort()).toEqual(['outside-change', 'outside.txt']);
  });

  // source capabilities may retain their original Place only for same-host clipboard transfers
  it('copies across Places while destination authority belongs to the receiving Place', async () => {
    const f = await start();
    const source = await f.app.inject({ method: 'POST', url: url(f.worktree.id, '/files/list'), headers: f.headers, payload: {} });
    const destinationPlace = f.places[0]!.id;
    const destination = await f.app.inject({ method: 'POST', url: url(destinationPlace, '/files/list'), headers: f.headers, payload: { path: f.outside } });
    const prepared = await f.app.inject({ method: 'POST', url: url(destinationPlace, '/files/operations/prepare'), headers: f.headers, payload: { kind: 'copy', sourceTokens: [source.json().entries[0].objectToken], destinationDirectoryToken: destination.json().destinationDirectoryToken } });
    expect(prepared.statusCode).toBe(200);
    const operationId = prepared.json().operationId;
    const execute = await f.app.inject({ method: 'POST', url: url(destinationPlace, `/files/operations/${operationId}/execute`), headers: f.headers, payload: { decisions: {} } });
    expect(execute.statusCode).toBe(202);
    expect((await terminal(f.app, destinationPlace, operationId, f.headers)).state).toBe('completed');
    expect(await readFile(join(f.outside, '.hidden'), 'utf8')).toBe('hidden');
    expect(await readFile(join(f.home, '.hidden'), 'utf8')).toBe('hidden');
  });

});
