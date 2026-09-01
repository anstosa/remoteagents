import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as sendRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { ProjectProxy } from '../src/project-proxy.js';
import { testWorktree } from './helpers/config.js';

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
const request = async (port: number, path: string, options: { method?: string; body?: string; headers?: IncomingHttpHeaders } = {}) => await new Promise<{ status: number; body: string; contentType?: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
  const outgoing = sendRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: 'project.example.com', ...options.headers, ...(options.body === undefined ? {} : { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(options.body) }) } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), contentType: response.headers['content-type'], headers: response.headers }));
  });
  outgoing.once('error', reject);
  // forward an optional request body
  if (options.body !== undefined) outgoing.write(options.body);
  outgoing.end();
});

// execute one injected bridge against a mobile navigator
const executeBridge = (source: string, lockUserAgent = false) => {
  const messages: Array<{ properties?: string[]; type?: string }> = [];
  const userAgentData = {
    brands: [{ brand: 'Chromium', version: '140' }],
    mobile: true,
    platform: 'Android',
    // expose contradictory mobile high-entropy hints
    getHighEntropyValues: async (_hints: string[]) => ({ architecture: 'arm', bitness: '64', formFactors: ['Mobile'], mobile: true, model: 'Pixel 9', platform: 'Android', platformVersion: '15.0.0', wow64: false }),
    // serialize the original mobile identity
    toJSON: () => ({ brands: [{ brand: 'Chromium', version: '140' }], mobile: true, platform: 'Android' })
  };
  const navigator = { appVersion: '5.0 (Linux; Android 15; Pixel 9) Mobile', platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36', userAgentData };
  // force one observable override failure
  if (lockUserAgent) Object.defineProperty(navigator, 'userAgent', { configurable: false, value: navigator.userAgent });
  const window = {
    addEventListener: () => undefined,
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { href: 'https://project.example.com/dashboard' },
    navigator,
    parent: { postMessage: (message: { properties?: string[]; type?: string }) => messages.push(message) },
    queueMicrotask: (callback: () => void) => callback()
  };
  runInNewContext(source, { window });
  return { messages, navigator };
};

afterEach(async () => {
  // close every ephemeral listener
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('project browser proxy', () => {
  // reject arbitrary upstream destinations
  it('allows only local project gateways', () => {
    expect(() => new ProjectProxy(() => [], 'https://agents.example.com', 'example.com')).toThrow('invalid project proxy host');
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
    const worktree = testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const projectProxy = new ProjectProxy(() => [worktree], 'https://agents.example.com');
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

  // verify paired viewport identities
  it('applies mobile and desktop identities to project traffic', async () => {
    const receivedHeaders: IncomingHttpHeaders[] = [];
    const upstream = createServer((request, response) => {
      receivedHeaders.push(request.headers);
      response.setHeader('content-type', 'text/plain');
      response.end('profiled');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const worktree = testWorktree({ projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const projectProxy = new ProjectProxy(() => [worktree], 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const mobileRedirect = await request(proxyPort, '/__rac/browser-device?mode=mobile&location=%2Fdashboard%3Ftab%3Done%23results');
    expect(mobileRedirect.status).toBe(302);
    expect(mobileRedirect.headers.location).toBe('/dashboard?tab=one#results');
    expect(mobileRedirect.headers['set-cookie']).toEqual(['__rac_browser_device=mobile; Path=/; HttpOnly; Secure; SameSite=None; Partitioned']);

    const rejectedDeviceUrls = [
      '/__rac/browser-device',
      '/__rac/browser-device?mode=mobile',
      '/__rac/browser-device?mode=tablet&location=%2F',
      '/__rac/browser-device?mode=mobile&location=https%3A%2F%2Fevil.example',
      '/__rac/browser-device?mode=mobile&location=%2F%2Fevil.example',
      '/__rac/browser-device?mode=mobile&location=%2F%5Cevil.example',
      '/__rac/browser-device?mode=mobile&location=%E0%A4%A'
    ];
    // reject every malformed or cross-origin transition
    for (const path of rejectedDeviceUrls) {
      const rejected = await request(proxyPort, path);
      expect(rejected.status).toBe(400);
      expect(rejected.headers.location).toBeUndefined();
      expect(rejected.headers['set-cookie']).toBeUndefined();
    }

    const mobile = await request(proxyPort, '/dashboard', { headers: { cookie: 'project=value; __rac_browser_device=mobile', 'sec-ch-ua-arch': '"x86"', 'sec-ch-ua-bitness': '"32"', 'sec-ch-ua-form-factors': '"Desktop"', 'sec-ch-ua-model': '"Desktop"', 'sec-ch-ua-platform-version': '"6.0.0"', 'sec-ch-ua-wow64': '?1', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Safari/537.36' } });
    expect(mobile.status).toBe(200);
    expect(receivedHeaders.at(-1)?.['user-agent']).toContain('Chrome/140.1.2.3 Mobile');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-mobile']).toBe('?1');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-arch']).toBe('"arm"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-form-factors']).toBe('"Mobile"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform']).toBe('"Android"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform-version']).toBe('"10.0.0"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-model']).toBe('""');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-wow64']).toBe('?0');
    expect(receivedHeaders.at(-1)?.cookie).toBe('project=value');

    await request(proxyPort, '/dashboard', { headers: { cookie: '__rac_browser_device=desktop', 'sec-ch-ua-arch': '"arm"', 'sec-ch-ua-form-factors': '"Mobile"', 'sec-ch-ua-model': '"Pixel 9"', 'sec-ch-ua-platform-version': '"15.0.0"', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Mobile Safari/537.36' } });
    expect(receivedHeaders.at(-1)?.['user-agent']).toContain('X11; Linux x86_64');
    expect(receivedHeaders.at(-1)?.['user-agent']).not.toContain(' Mobile ');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-mobile']).toBe('?0');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-arch']).toBe('"x86"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-form-factors']).toBe('"Desktop"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-model']).toBe('""');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform']).toBe('"Linux"');
    expect(receivedHeaders.at(-1)?.['sec-ch-ua-platform-version']).toBe('"6.0.0"');

    const desktopBridge = await request(proxyPort, '/__rac/browser-bridge.js', { headers: { cookie: '__rac_browser_device=desktop', 'user-agent': 'Mozilla/5.0 Chrome/140.1.2.3 Mobile Safari/537.36' } });
    const executed = executeBridge(desktopBridge.body);
    expect(executed.navigator.userAgent).toContain('X11; Linux x86_64');
    expect(executed.navigator.userAgent).not.toContain(' Mobile ');
    expect(executed.navigator.appVersion).toContain('X11; Linux x86_64');
    expect(executed.navigator.appVersion).not.toContain('Android');
    expect(executed.navigator.platform).toBe('Linux x86_64');
    expect(executed.navigator.userAgentData.mobile).toBe(false);
    expect(executed.navigator.userAgentData.platform).toBe('Linux');
    expect(executed.navigator.userAgentData.toJSON()).toMatchObject({ mobile: false, platform: 'Linux' });
    await expect(executed.navigator.userAgentData.getHighEntropyValues(['architecture', 'formFactors', 'model', 'platformVersion'])).resolves.toMatchObject({ architecture: 'x86', formFactors: ['Desktop'], mobile: false, model: '', platform: 'Linux', platformVersion: '6.0.0' });

    const failed = executeBridge(desktopBridge.body, true);
    expect(failed.messages).toContainEqual({ type: 'rac-browser-device-error', properties: ['userAgent'] });
  });

  // the map is built from live Worktree records, each carrying its Project's URL/port —
  // two branches running stacks concurrently share the one preview, and a later
  // per-Worktree port is an additive key on the same records
  it('serves one Project preview from the Worktree records of concurrently running branches', async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('whichever stack bound the port');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const main = testWorktree({ projectId: 'proj', path: '/worktrees/main', projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    const branch = testWorktree({ projectId: 'proj', path: '/worktrees/branch', main: false, branch: 'feature', projectUrl: 'https://project.example.com', projectPort: upstreamPort });
    // a record without a loopback port claims no hostname
    const incomplete = testWorktree({ projectId: 'other', path: '/worktrees/other', projectUrl: 'https://other.example.com' });
    let records = [main, branch, incomplete];
    const projectProxy = new ProjectProxy(() => records, 'https://agents.example.com');
    const proxy = createServer((incoming, response) => {
      // reject unmatched virtual hosts
      if (!projectProxy.handle(incoming, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    // both Worktrees resolve the Project's one preview target
    expect((await request(proxyPort, '/')).body).toBe('whichever stack bound the port');
    expect((await request(proxyPort, '/', { headers: { host: 'other.example.com' } })).status).toBe(404);

    // a same-length snapshot replacement that only moves the port is picked up —
    // the memoization keys on snapshot identity, never on shape
    const moved = createServer((_request, response) => { response.setHeader('content-type', 'text/plain'); response.end('the moved stack'); });
    servers.push(moved);
    const movedPort = await listen(moved);
    records = records.map(record => ({ ...record, projectPort: record.projectPort === undefined ? undefined : movedPort }));
    expect((await request(proxyPort, '/')).body).toBe('the moved stack');

    // discovery replacing its snapshot (Worktrees removed, Project unavailable) is
    // picked up without rebuilding the proxy
    records = [];
    expect((await request(proxyPort, '/')).status).toBe(404);
  });
});
