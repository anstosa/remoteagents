import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { request as httpRequest } from 'node:http';
import { contentDisposition, registerHostFilesRoutes } from '../src/host-files/routes.js';
import type { HostFilesService } from '../src/host-files/service.js';
import type { Session } from '../src/auth/service.js';
import { HostFilesTransportError } from '../src/host-files/protocol.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  // close every isolated live route fixture
  for (const app of apps.splice(0)) await app.close();
});

// return one status after sending headers but no declared body bytes
async function headersOnly(port: number, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'PUT', path: '/api/worktrees/place/files/uploads/upload/client', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '70000', 'x-files-upload-token': 'token' } });
    request.once('error', reject);
    request.once('response', response => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once('end', () => { request.destroy(); resolve(status); });
    });
    request.flushHeaders();
  });
}

describe('host Files raw upload boundary', () => {
  // reject Origin and CSRF before waiting for or consuming a large upload body
  it('authenticates before raw-body parsing and keeps the parser route-local', async () => {
    const upload = vi.fn();
    const list = vi.fn();
    const app = Fastify();
    apps.push(app);
    const controlled = (request: FastifyRequest, mutation = false): Session => {
      // require the fixture session first
      if (request.headers.cookie !== 'session=yes') throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      // require the exact same origin for mutation routes
      if (mutation && request.headers.origin !== 'https://agents.example.com') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      // require one CSRF token before the parser runs
      if (mutation && request.headers['x-csrf-token'] !== 'csrf') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      return { id: 'session', csrf: 'csrf' };
    };
    await registerHostFilesRoutes(app, {
      service: { upload, list } as unknown as HostFilesService,
      controlled,
      resolvePlace: async id => ({ id, kind: 'scratch', projectId: 'scratch', label: 'Place', home: '/tmp' }),
      downloadTickets: { mint: () => ({ id: 'ticket', sessionId: 'session', kind: 'files-download', target: 'target', expires: Date.now() + 1_000 }), consume: () => true },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    // require the live fixture listener
    if (address === null || typeof address === 'string') throw new Error('missing fixture listener');
    expect(await headersOnly(address.port, { cookie: 'session=yes', origin: 'https://foreign.example.com', 'x-csrf-token': 'csrf' })).toBe(403);
    expect(await headersOnly(address.port, { cookie: 'session=yes', origin: 'https://agents.example.com' })).toBe(403);
    expect(upload).not.toHaveBeenCalled();
    const unrelated = await app.inject({ method: 'POST', url: '/api/worktrees/place/files/list', headers: { cookie: 'session=yes', origin: 'https://agents.example.com', 'x-csrf-token': 'csrf', 'content-type': 'application/octet-stream' }, payload: Buffer.from('{}') });
    expect(unrelated.statusCode).toBe(415);
    list.mockRejectedValueOnce(new HostFilesTransportError('bridge_unavailable', 'private socket /secret failed'));
    const unavailable = await app.inject({ method: 'POST', url: '/api/worktrees/place/files/list', headers: { cookie: 'session=yes', origin: 'https://agents.example.com', 'x-csrf-token': 'csrf' }, payload: {} });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: { code: 'bridge_unavailable', message: 'host files bridge is unavailable' } });
    expect(unavailable.body).not.toContain('/secret');
    list.mockRejectedValueOnce(new HostFilesTransportError('broker_busy', 'private broker detail'));
    const busy = await app.inject({ method: 'POST', url: '/api/worktrees/place/files/list', headers: { cookie: 'session=yes', origin: 'https://agents.example.com', 'x-csrf-token': 'csrf' }, payload: {} });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toEqual({ error: { code: 'broker_busy', message: 'host files broker is busy', retryable: true, retryAfterMs: 1000 } });
  });

  // encode unusual names without creating ambiguous attachment parameters
  it('encodes RFC 5987 attachment names', () => {
    expect(contentDisposition("résumé (final)*'2026.txt")).toBe("attachment; filename=\"r_sum_ (final)*'2026.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29%2A%272026.txt");
  });
});
