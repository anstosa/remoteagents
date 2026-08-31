import { request as sendHttpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Worktree } from './domain/models.js';

const browserBridgePath = '/__rac/browser-bridge.js';
const browserDevicePath = '/__rac/browser-device';
const browserDeviceCookie = '__rac_browser_device';
type BrowserDevice = 'desktop' | 'mobile';
type BrowserDeviceProfile = { appVersion: string; architecture: string; bitness: string; formFactors: string[]; mobile: boolean; model: string; navigatorPlatform: string; platform: string; platformVersion: string; userAgent: string; wow64: boolean };
// build one browser identity from the requesting engine version
const browserDeviceProfile = (device: BrowserDevice, currentUserAgent = ''): BrowserDeviceProfile => {
  const chromiumVersion = /(?:Chrome|CriOS)\/([\d.]+)/u.exec(currentUserAgent)?.[1] ?? '120.0.0.0';
  // identify the narrow touch profile
  if (device === 'mobile') {
    const userAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Mobile Safari/537.36`;
    return { appVersion: userAgent.replace(/^Mozilla\//u, ''), architecture: 'arm', bitness: '64', formFactors: ['Mobile'], mobile: true, model: '', navigatorPlatform: 'Linux armv8l', platform: 'Android', platformVersion: '10.0.0', userAgent, wow64: false };
  }
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
  return { appVersion: userAgent.replace(/^Mozilla\//u, ''), architecture: 'x86', bitness: '64', formFactors: ['Desktop'], mobile: false, model: '', navigatorPlatform: 'Linux x86_64', platform: 'Linux', platformVersion: '6.0.0', userAgent, wow64: false };
};
// read the private device cookie
const requestBrowserDevice = (headers: IncomingHttpHeaders): BrowserDevice | undefined => {
  const cookie = Array.isArray(headers.cookie) ? headers.cookie.join(';') : headers.cookie;
  // skip requests without cookies
  if (cookie === undefined) return undefined;
  const encoded = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${browserDeviceCookie}=`))?.slice(browserDeviceCookie.length + 1);
  return encoded === 'desktop' || encoded === 'mobile' ? encoded : undefined;
};
// remove the proxy-owned device cookie
const upstreamCookie = (cookie: string | string[] | undefined) => {
  // skip missing cookie headers
  if (cookie === undefined) return undefined;
  const values = (Array.isArray(cookie) ? cookie.join(';') : cookie).split(';').map(value => value.trim()).filter(value => value !== '' && !value.startsWith(`${browserDeviceCookie}=`));
  return values.length === 0 ? undefined : values.join('; ');
};
// build a bridge restricted to the console origin
const browserBridge = (parentOrigin: string, profile?: BrowserDeviceProfile) => `(() => {
  ${profile === undefined ? '' : `// expose the selected browser identity before application scripts run
  const profile = ${JSON.stringify(profile)};
  const identityFailures = [];
  // apply one navigator property override
  const override = (name, value) => {
    try { Object.defineProperty(window.navigator, name, { configurable: true, get: () => value }); }
    catch { identityFailures.push(name); }
  };
  override('userAgent', profile.userAgent);
  override('appVersion', profile.appVersion);
  override('platform', profile.navigatorPlatform);
  const originalUserAgentData = window.navigator.userAgentData;
  // preserve browser brands while normalizing device hints
  if (originalUserAgentData) {
    const highEntropyProfile = { architecture: profile.architecture, bitness: profile.bitness, formFactors: profile.formFactors, model: profile.model, platformVersion: profile.platformVersion, wow64: profile.wow64 };
    const userAgentData = new Proxy(originalUserAgentData, {
      // return one coherent client-hint surface
      get(target, name) {
        // normalize the mobile hint
        if (name === 'mobile') return profile.mobile;
        // normalize the platform hint
        if (name === 'platform') return profile.platform;
        // serialize normalized low-entropy hints
        if (name === 'toJSON') return () => ({ brands: target.brands, mobile: profile.mobile, platform: profile.platform });
        // normalize requested high-entropy hints
        if (name === 'getHighEntropyValues') return async hints => {
          const values = typeof target.getHighEntropyValues === 'function' ? await target.getHighEntropyValues(hints) : {};
          // replace every requested device hint
          for (const hint of hints) {
            // replace supported device hints
            if (Object.prototype.hasOwnProperty.call(highEntropyProfile, hint)) values[hint] = highEntropyProfile[hint];
          }
          return { ...values, brands: target.brands, mobile: profile.mobile, platform: profile.platform };
        };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    override('userAgentData', userAgentData);
  }
  `}
  // report the visible location
  const report = () => {
    window.parent.postMessage({ type: 'rac-browser-location', url: window.location.href }, ${JSON.stringify(parentOrigin)});
    // surface unsupported identity overrides
    if (typeof identityFailures !== 'undefined' && identityFailures.length > 0) window.parent.postMessage({ type: 'rac-browser-device-error', properties: identityFailures }, ${JSON.stringify(parentOrigin)});
  };
  // forward embedded reload shortcuts
  const refresh = (event) => {
    // intercept only one browser reload chord
    if (event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'r') return;
    event.preventDefault();
    window.parent.postMessage({ type: 'rac-browser-refresh' }, ${JSON.stringify(parentOrigin)});
  };
  // wrap history navigation
  const wrap = (name) => {
    const original = window.history[name];
    window.history[name] = function (...args) {
      const result = original.apply(this, args);
      window.queueMicrotask(report);
      return result;
    };
  };
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);
  window.addEventListener('pageshow', report);
  window.addEventListener('keydown', refresh);
  report();
})();`;
const browserBridgeTag = `<script src="${browserBridgePath}"></script>`;
const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const browserIdentityHeaders = new Set(['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64']);
const maxHtmlBytes = 2 * 1024 * 1024;
const maxRequestBytes = 16 * 1024 * 1024;
const upstreamTimeoutMs = 30_000;
const maxActiveUpgrades = 128;
const maxActiveUpgradesPerTarget = 32;
const maxUpgradeHeaderBytes = 16 * 1024;

type ProjectTarget = { port: number };
const allowedUpstreamHosts = new Set(['127.0.0.1', '::1', 'host.docker.internal']);

// normalize an incoming host header
const requestHostname = (host: string | undefined) => {
  // reject missing or malformed hosts
  if (host === undefined) return undefined;
  try { return new URL(`http://${host}`).hostname; }
  catch { return undefined; }
};

// omit transport-owned request headers
const upstreamHeaders = (headers: IncomingHttpHeaders, target: ProjectTarget) => {
  const forwarded: IncomingHttpHeaders = {};
  const device = requestBrowserDevice(headers);
  // retain end-to-end headers
  for (const [name, value] of Object.entries(headers)) {
    // skip connection-specific headers
    if (hopByHopHeaders.has(name) || name === 'host' || name === 'accept-encoding' || name === 'cookie' || device !== undefined && browserIdentityHeaders.has(name)) continue;
    forwarded[name] = value;
  }
  const cookie = upstreamCookie(headers.cookie);
  // retain only project-owned cookies
  if (cookie !== undefined) forwarded.cookie = cookie;
  // override browser identity for an explicit preview mode
  if (device !== undefined) {
    const profile = browserDeviceProfile(device, typeof headers['user-agent'] === 'string' ? headers['user-agent'] : '');
    forwarded['user-agent'] = profile.userAgent;
    forwarded['sec-ch-ua-mobile'] = profile.mobile ? '?1' : '?0';
    forwarded['sec-ch-ua-platform'] = `"${profile.platform}"`;
    const highEntropyHeaders: Array<[string, string]> = [
      ['sec-ch-ua-arch', `"${profile.architecture}"`],
      ['sec-ch-ua-bitness', `"${profile.bitness}"`],
      ['sec-ch-ua-form-factors', profile.formFactors.map(value => `"${value}"`).join(', ')],
      ['sec-ch-ua-model', `"${profile.model}"`],
      ['sec-ch-ua-platform-version', `"${profile.platformVersion}"`],
      ['sec-ch-ua-wow64', profile.wow64 ? '?1' : '?0']
    ];
    // normalize only client-requested high-entropy hints
    for (const [name, value] of highEntropyHeaders) {
      // retain the browser's hint disclosure boundary
      if (headers[name] !== undefined) forwarded[name] = value;
    }
  }
  forwarded.host = `localhost:${target.port}`;
  forwarded['accept-encoding'] = 'identity';
  return forwarded;
};

// validate one same-origin device redirect
const browserDeviceRedirect = (requestUrl: string | undefined) => {
  // reject missing or malformed endpoint requests
  if (requestUrl === undefined) return undefined;
  try {
    const request = new URL(requestUrl, 'http://project.invalid');
    const device = request.searchParams.get('mode');
    const location = request.searchParams.get('location');
    // require a known mode and root-relative destination
    if ((device !== 'desktop' && device !== 'mobile') || location === null || !location.startsWith('/') || location.startsWith('//')) return undefined;
    const destination = new URL(location, request.origin);
    // retain only same-origin paths
    if (destination.origin !== request.origin) return undefined;
    return { device, location: `${destination.pathname}${destination.search}${destination.hash}` };
  } catch { return undefined; }
};

// omit transport-owned response headers
const downstreamHeaders = (headers: IncomingHttpHeaders) => {
  const forwarded: IncomingHttpHeaders = {};
  // retain end-to-end headers
  for (const [name, value] of Object.entries(headers)) {
    // skip connection-specific headers
    if (hopByHopHeaders.has(name)) continue;
    forwarded[name] = value;
  }
  return forwarded;
};

// inject the cross-origin navigation bridge
export const injectProjectBrowserBridge = (html: string) => {
  // avoid duplicate injection
  if (html.includes(browserBridgePath)) return html;
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  // prepend when no head exists
  if (head === null || head.index === undefined) return `${browserBridgeTag}${html}`;
  const insertion = head.index + head[0].length;
  return `${html.slice(0, insertion)}${browserBridgeTag}${html.slice(insertion)}`;
};

// proxy configured project hosts and inject navigation reporting
export class ProjectProxy {
  private readonly targets = new Map<string, ProjectTarget>();
  private readonly activeUpgrades = new Map<number, number>();
  private activeUpgradeCount = 0;
  private readonly parentOrigin: string;
  private readonly upstreamHost: string;

  // index fixed loopback targets
  constructor(worktrees: Worktree[], parentOrigin: string, upstreamHost = '127.0.0.1') {
    // restrict proxy destinations to local host gateways
    if (!allowedUpstreamHosts.has(upstreamHost)) throw new Error('invalid project proxy host');
    this.parentOrigin = parentOrigin;
    this.upstreamHost = upstreamHost;
    // retain only complete project proxy configurations
    for (const worktree of worktrees) {
      // skip projects without public and loopback locations
      if (worktree.projectUrl === undefined || worktree.projectPort === undefined) continue;
      const hostname = new URL(worktree.projectUrl).hostname;
      this.targets.set(hostname, { port: worktree.projectPort });
    }
  }

  // find an allowed project target
  private target(host: string | undefined) {
    const hostname = requestHostname(host);
    return hostname === undefined ? undefined : this.targets.get(hostname);
  }

  // proxy an ordinary HTTP request
  handle(request: IncomingMessage, response: ServerResponse) {
    const target = this.target(request.headers.host);
    // leave console hosts to Fastify
    if (target === undefined) return false;
    // set preview identity before loading the retained location
    if (request.url === browserDevicePath || request.url?.startsWith(`${browserDevicePath}?`)) {
      const redirect = browserDeviceRedirect(request.url);
      // reject malformed device transitions
      if (redirect === undefined) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('invalid browser device');
        return true;
      }
      response.writeHead(302, { 'cache-control': 'no-store', location: redirect.location, 'set-cookie': `${browserDeviceCookie}=${redirect.device}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned` });
      response.end();
      return true;
    }
    // serve the injected bridge from the project origin
    if (request.url === browserBridgePath) {
      const device = requestBrowserDevice(request.headers);
      const profile = device === undefined ? undefined : browserDeviceProfile(device, typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : '');
      const bridge = browserBridge(this.parentOrigin, profile);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(bridge) });
      response.end(bridge);
      return true;
    }
    const declaredRequestBytes = Number(request.headers['content-length'] ?? 0);
    // reject oversized declared request bodies
    if (!Number.isFinite(declaredRequestBytes) || declaredRequestBytes < 0 || declaredRequestBytes > maxRequestBytes) {
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('project request too large');
      request.destroy();
      return true;
    }
    let requestBytes = 0;
    // enforce streaming request bounds
    request.on('data', chunk => {
      requestBytes += Buffer.byteLength(chunk);
      if (requestBytes > maxRequestBytes) request.destroy(new Error('project request too large'));
    });
    const upstream = sendHttpRequest({ hostname: this.upstreamHost, port: target.port, method: request.method, path: request.url, headers: upstreamHeaders(request.headers, target) }, upstreamResponse => {
      const headers = downstreamHeaders(upstreamResponse.headers);
      const contentType = upstreamResponse.headers['content-type'];
      const html = typeof contentType === 'string' && contentType.toLowerCase().includes('text/html');
      // stream non-HTML responses unchanged
      if (!html) {
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      // collect HTML for one bridge insertion
      upstreamResponse.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        // bound public HTML transformation memory
        if (bytes > maxHtmlBytes) { upstreamResponse.destroy(new Error('project response too large')); return; }
        chunks.push(buffer);
      });
      upstreamResponse.on('end', () => {
        // ignore an aborted oversized response
        if (upstreamResponse.destroyed && !upstreamResponse.complete) return;
        const body = injectProjectBrowserBridge(Buffer.concat(chunks).toString('utf8'));
        delete headers['content-length'];
        delete headers.etag;
        headers['content-length'] = String(Buffer.byteLength(body));
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        response.end(body);
      });
      // bound stalled upstream responses
      upstreamResponse.setTimeout(upstreamTimeoutMs, () => upstreamResponse.destroy(new Error('project response timed out')));
      upstreamResponse.on('error', () => {
        // close partial downstream responses
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(bytes > maxHtmlBytes ? 502 : 504, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(bytes > maxHtmlBytes ? 'project response too large' : 'project response timed out');
      });
    });
    // bound connection and response-header waits
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('project request timed out')));
    response.once('close', () => upstream.destroy());
    // return a bounded gateway error
    upstream.on('error', () => {
      // avoid writing after an upstream response began
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('project unavailable');
    });
    request.pipe(upstream);
    return true;
  }

  // proxy a WebSocket upgrade before Fastify routing
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const target = this.target(request.headers.host);
    // leave console upgrades to Fastify
    if (target === undefined) return false;
    const targetCount = this.activeUpgrades.get(target.port) ?? 0;
    // reject public upgrade exhaustion
    if (this.activeUpgradeCount >= maxActiveUpgrades || targetCount >= maxActiveUpgradesPerTarget) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    this.activeUpgradeCount += 1;
    this.activeUpgrades.set(target.port, targetCount + 1);
    let released = false;
    // release shared connection accounting once
    const release = () => {
      if (released) return;
      released = true;
      this.activeUpgradeCount -= 1;
      const remaining = (this.activeUpgrades.get(target.port) ?? 1) - 1;
      if (remaining === 0) this.activeUpgrades.delete(target.port);
      else this.activeUpgrades.set(target.port, remaining);
    };
    const upstream = connect(target.port, this.upstreamHost);
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('project upgrade timed out')));
    let handshake = Buffer.alloc(0);
    // validate one bounded upstream handshake
    const inspectHandshake = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      // wait for the complete response header
      if (headerEnd < 0) {
        // reject an unterminated oversized response header
        if (handshake.length > maxUpgradeHeaderBytes) upstream.destroy(new Error('project upgrade headers too large'));
        return;
      }
      // bound only the response header bytes
      if (headerEnd + 4 > maxUpgradeHeaderBytes) { upstream.destroy(new Error('project upgrade headers too large')); return; }
      const status = /^HTTP\/1\.[01] 101(?:\s|$)/u.test(handshake.subarray(0, headerEnd).toString('latin1'));
      // require a successful protocol switch
      if (!status) { upstream.destroy(new Error('project upgrade rejected')); return; }
      upstream.off('data', inspectHandshake);
      upstream.setTimeout(0);
      handshake = Buffer.alloc(0);
    };
    upstream.on('data', inspectHandshake);
    // forward the original upgrade after connecting
    upstream.once('connect', () => {
      const headers = upstreamHeaders(request.headers, target);
      headers.connection = 'Upgrade';
      headers.upgrade = request.headers.upgrade ?? 'websocket';
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
      // serialize forwarded upgrade headers
      for (const [name, value] of Object.entries(headers)) {
        // skip absent headers
        if (value === undefined) continue;
        // preserve repeated headers
        if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
        else lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      // preserve buffered client bytes
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    // close both sides on connection failure
    upstream.once('error', () => socket.destroy());
    upstream.once('close', release);
    // contain public client resets
    socket.once('error', () => { upstream.destroy(); release(); });
    socket.once('close', () => { upstream.destroy(); release(); });
    return true;
  }
}
