import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as sendRequest, type Server } from 'node:http';
import { ProjectProxy } from '../src/project-proxy.js';
import type { Worktree } from '../src/domain/models.js';

const servers: Server[] = [];

// listen on an ephemeral loopback port
const listen = async (server: Server) => await new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    // reject unexpected non-TCP listeners
    if (address === null || typeof address === 'string') { reject(new Error('missing listener')); return; }
    resolve(address.port);
  });
});

// send one request through a test proxy
const request = async (port: number, path: string, options: { method?: string; body?: string } = {}) => await new Promise<{ status: number; body: string; contentType?: string }>((resolve, reject) => {
  const outgoing = sendRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: 'project.example.com', ...(options.body === undefined ? {} : { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(options.body) }) } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), contentType: response.headers['content-type'] }));
  });
  outgoing.once('error', reject);
  // forward an optional request body
  if (options.body !== undefined) outgoing.write(options.body);
  outgoing.end();
});

afterEach(async () => {
  // close every ephemeral listener
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('project browser proxy', () => {
  // reject arbitrary upstream destinations
  it('allows only local project gateways', () => {
    expect(() => new ProjectProxy([], 'https://agents.example.com', 'example.com')).toThrow('invalid project proxy host');
  });

  // verify HTML injection and transparent forwarding
  it('injects the navigation bridge and forwards project traffic', async () => {
    const upstream = createServer((request, response) => {
      // echo non-page requests
      if (request.url !== '/') { request.pipe(response); return; }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>Project</title></head><body>Preview</body></html>');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const worktree: Worktree = { id: 'project', label: 'Project', path: '/tmp/project', identity: '/tmp/project', available: true, pinned: true, command: 'codex', projectUrl: 'https://project.example.com', projectPort: upstreamPort };
    const projectProxy = new ProjectProxy([worktree], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const page = await request(proxyPort, '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<head><script src="/__rac/browser-bridge.js"></script>');

    const bridge = await request(proxyPort, '/__rac/browser-bridge.js');
    expect(bridge.status).toBe(200);
    expect(bridge.contentType).toContain('text/javascript');
    expect(bridge.body).toContain("wrap('pushState')");
    expect(bridge.body).toContain("type: 'rac-browser-refresh'");
    expect(bridge.body).toContain("window.addEventListener('keydown', refresh)");
    expect(bridge.body).toContain('"https://agents.example.com"');

    const forwarded = await request(proxyPort, '/echo', { method: 'POST', body: 'retained request body' });
    expect(forwarded.body).toBe('retained request body');
  });
});
