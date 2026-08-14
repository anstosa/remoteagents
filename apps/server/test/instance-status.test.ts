import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceAttention, RemoteInstanceStatusPoller, validInstanceStatusRequest } from '../src/instance-status.js';

const secret = 'status-secret-with-at-least-thirty-two-bytes';
const remote = { name: 'Framework', url: new URL('https://framework.example') };

afterEach(() => {
  // restore global transport and clock fixtures
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('instance attention', () => {
  // prioritize questions over completed notifications
  it('returns question before completed and idle states', () => {
    expect(instanceAttention({ agents: [{ id: 'ready', title: 'Ready', unread: true }, { id: 'question', title: 'Action required', unread: false }] as never })).toBe('question');
    expect(instanceAttention({ agents: [{ id: 'ready', title: 'Ready', unread: true }] as never })).toBe('completed');
    expect(instanceAttention({ agents: [{ id: 'ready', title: 'Ready', unread: false }] as never })).toBe('idle');
  });
});

describe('remote instance status', () => {
  // authenticate one outbound request and reject replayed variants
  it('signs fresh requests with the shared peer secret', async () => {
    let requestHeaders = new Headers();
    // capture the generated authentication headers
    const fetchStatus = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ attention: 'idle' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([remote])).resolves.toEqual([{ url: remote.url.origin, attention: 'idle' }]);

    const timestamp = requestHeaders.get('x-rac-status-timestamp');
    const signature = requestHeaders.get('x-rac-status-signature');
    const requestedAt = Number(timestamp);
    expect(validInstanceStatusRequest(secret, remote.url.origin, timestamp, signature, requestedAt)).toBe(true);
    expect(validInstanceStatusRequest(`${secret}-wrong`, remote.url.origin, timestamp, signature, requestedAt)).toBe(false);
    expect(validInstanceStatusRequest(secret, remote.url.origin, timestamp, signature, requestedAt + 30_001)).toBe(false);
  });

  // coalesce concurrent requests and retain one cache window
  it('shares in-flight and cached remote polls', async () => {
    let now = 1_800_000_000_000;
    let release!: (response: Response) => void;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // hold the first request while a second caller joins it
    const fetchStatus = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetchStatus);
    const poller = new RemoteInstanceStatusPoller(secret);

    const first = poller.statuses([remote]);
    const second = poller.statuses([remote]);
    await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ attention: 'completed' }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ url: remote.url.origin, attention: 'completed' }],
      [{ url: remote.url.origin, attention: 'completed' }]
    ]);
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, attention: 'completed' }]);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    now += 5_001;
    fetchStatus.mockResolvedValueOnce(new Response(JSON.stringify({ attention: 'question' }), { status: 200 }));
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, attention: 'question' }]);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  // fail closed for unsafe or oversized peer responses
  it('marks redirects, oversized bodies, and malformed payloads unavailable', async () => {
    const redirected = { name: 'Redirected', url: new URL('https://redirected.example') };
    const oversized = { name: 'Oversized', url: new URL('https://oversized.example') };
    const malformed = { name: 'Malformed', url: new URL('https://malformed.example') };
    // return one hostile response for each distinct peer
    const fetchStatus = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const origin = new URL(String(input)).origin;
      // simulate a redirect rejected by fetch
      if (origin === redirected.url.origin) throw new TypeError('redirect rejected');
      // reject a declared oversized response before reading it
      if (origin === oversized.url.origin) return new Response('x'.repeat(1_025), { status: 200, headers: { 'content-length': '1025' } });
      return new Response(JSON.stringify({ attention: 'unknown' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([redirected, oversized, malformed])).resolves.toEqual([
      { url: redirected.url.origin, attention: 'unavailable' },
      { url: oversized.url.origin, attention: 'unavailable' },
      { url: malformed.url.origin, attention: 'unavailable' }
    ]);
  });
});
