import type { FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { instanceIconSvg } from '../src/instance-icon.js';
import { testConfig } from './helpers/config.js';
import { testHost } from './helpers/auth.js';

const firstFixture = '<svg data-fixture="first"></svg>\n';
const secondFixture = '<svg data-fixture="second"></svg>\n';
// bypass auth for public icon routes
const auth = { unsign: () => undefined, get: () => undefined } as never;
let app: FastifyInstance;
let root: string | undefined;
let iconDirectory: string;

// build against one isolated private icon directory
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rac-instance-icon-routes-'));
  const configPath = join(root, 'config', 'server.yaml');
  iconDirectory = join(root, 'config', 'instance-icons');
  await mkdir(iconDirectory, { recursive: true });
  await writeFile(configPath, 'name: synthetic\n');
  await writeFile(join(iconDirectory, 'heart.svg'), firstFixture);
  await writeFile(join(iconDirectory, 'potato.svg'), secondFixture);
  vi.stubEnv('RAC_CONFIG', configPath);
  app = await buildApp(testConfig({ icon: 'heart' }), { auth });
});

// release app and filesystem state
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  // remove only the test-owned directory
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// preserve icon serving and host boundaries
describe('instance icon routes', () => {
  // serve configured and aliased private files unchanged
  it('serves the favicon and custom aliases byte-for-byte on the canonical host', async () => {
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const firstAlias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: testHost } });
    const secondAlias = await app.inject({ method: 'GET', url: '/instance-icons/potato.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');
    expect(favicon.body).toBe(firstFixture);
    expect(firstAlias.statusCode).toBe(200);
    expect(firstAlias.body).toBe(firstFixture);
    expect(secondAlias.statusCode).toBe(200);
    expect(secondAlias.body).toBe(secondFixture);
  });

  // fall back for unavailable private files on both routes
  it('serves the generic icon when custom assets are missing', async () => {
    await rm(join(iconDirectory, 'heart.svg'));
    await rm(join(iconDirectory, 'potato.svg'));

    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/potato.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(200);
    expect(favicon.body).toBe(instanceIconSvg());
    expect(alias.statusCode).toBe(200);
    expect(alias.body).toBe(instanceIconSvg());
  });

  // hide local paths while surfacing unreadable artwork
  it('returns a stable error when a custom asset cannot be read', async () => {
    await rm(join(iconDirectory, 'heart.svg'));
    await mkdir(join(iconDirectory, 'heart.svg'));

    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(500);
    expect(favicon.json()).toEqual({ error: 'icon unavailable' });
    expect(alias.statusCode).toBe(500);
    expect(alias.json()).toEqual({ error: 'icon unavailable' });
  });

  // reject names outside the published aliases
  it('returns not found for an unknown icon name', async () => {
    const response = await app.inject({ method: 'GET', url: '/instance-icons/unknown.svg', headers: { host: testHost } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'icon unavailable' });
  });

  // preserve the canonical host boundary
  it('forbids favicon and alias requests from another host', async () => {
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: 'other.example.com' } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: 'other.example.com' } });

    expect(favicon.statusCode).toBe(403);
    expect(alias.statusCode).toBe(403);
  });
});
