import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeySpendService } from '../src/accounts/spend.js';

const daySeconds = 24 * 60 * 60;
const adminKey = 'admin-secret-for-tests';
const providerKeyId = 'key_provider_one';

// convert one utc fixture into unix seconds
function unixSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

// build one documented costs result
function cost(keyId: unknown, value: unknown, currency: unknown = 'usd'): Record<string, unknown> {
  return { object: 'organization.costs.result', amount: { value, currency }, api_key_id: keyId };
}

// build one documented daily bucket
function bucket(startTime: number, results: unknown[], endTime = startTime + daySeconds): Record<string, unknown> {
  return { object: 'bucket', start_time: startTime, end_time: endTime, results };
}

// build one documented costs page
function page(data: unknown[], nextPage: string | null = null): Record<string, unknown> {
  return { object: 'page', data, has_more: nextPage !== null, next_page: nextPage };
}

// serialize one json provider response
function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

// adapt one focused fake to the fetch contract
function fakeFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as unknown as typeof fetch;
}

// configure one mapped service at a deterministic instant
function spendService(nowSeconds: number, request: typeof fetch, keyIds: Record<string, string> = { local: providerKeyId }): ApiKeySpendService {
  return new ApiKeySpendService({ adminKey, keyIds, fetch: request, now: () => nowSeconds * 1_000 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ApiKeySpendService configuration', () => {
  it('returns unconfigured without networking for missing, unmapped, or invalid configuration', async () => {
    const request = fakeFetch(async () => jsonResponse(page([])));
    const missingAdmin = new ApiKeySpendService({ adminKey: '', keyIds: { local: providerKeyId }, fetch: request });
    const missingMapping = new ApiKeySpendService({ adminKey, keyIds: {}, fetch: request });
    const invalidMapping = new ApiKeySpendService({ adminKey, keyIds: { 'not/a/local/id': providerKeyId }, fetch: request });

    await expect(missingAdmin.read('local')).resolves.toEqual({ status: 'unconfigured' });
    await expect(missingMapping.read('local')).resolves.toEqual({ status: 'unconfigured' });
    await expect(invalidMapping.read('local')).resolves.toEqual({ status: 'unconfigured' });
    expect(request).not.toHaveBeenCalled();
  });

  it('captures the dedicated environment configuration once', async () => {
    vi.stubEnv('RAC_OPENAI_ADMIN_KEY', 'first-admin-secret');
    vi.stubEnv('RAC_OPENAI_API_KEY_IDS', JSON.stringify({ local: 'key_first' }));
    const request = fakeFetch(async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.getAll('api_key_ids[]')).toEqual(['key_first']);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer first-admin-secret');
      return jsonResponse(page([]));
    });
    const service = new ApiKeySpendService({ fetch: request, now: () => Date.parse('2026-01-07T12:00:00Z') });
    vi.stubEnv('RAC_OPENAI_ADMIN_KEY', 'second-admin-secret');
    vi.stubEnv('RAC_OPENAI_API_KEY_IDS', JSON.stringify({ local: 'key_second' }));

    await expect(service.read('local')).resolves.toMatchObject({ status: 'available' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeySpendService utc aggregation', () => {
  // cover monday, month, and year transitions in the request range
  it.each([
    ['monday', '2026-01-05T12:34:56Z', '2026-01-05T00:00:00Z'],
    ['month', '2026-02-01T12:34:56Z', '2026-01-26T00:00:00Z'],
    ['year', '2026-01-01T12:34:56Z', '2025-12-29T00:00:00Z'],
    ['sunday', '2026-01-11T23:59:59Z', '2026-01-05T00:00:00Z']
  ])('queries the exact utc week across the %s boundary', async (_name, nowIso, weekStartIso) => {
    const now = unixSeconds(nowIso);
    const request = fakeFetch(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.openai.com');
      expect(url.pathname).toBe('/v1/organization/costs');
      expect(url.searchParams.get('start_time')).toBe(String(unixSeconds(weekStartIso)));
      expect(url.searchParams.get('end_time')).toBe(String(now));
      expect(url.searchParams.get('bucket_width')).toBe('1d');
      expect(url.searchParams.get('limit')).toBe('7');
      expect(url.searchParams.getAll('api_key_ids[]')).toEqual([providerKeyId]);
      expect(url.searchParams.getAll('group_by[]')).toEqual(['api_key_id']);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(page([]));
    });

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'available', todayUsd: 0, weekUsd: 0, asOf: now });
  });

  it('sums exact-key daily costs without rounding and ignores other-key rows', async () => {
    const monday = unixSeconds('2026-01-05T00:00:00Z');
    const wednesday = unixSeconds('2026-01-07T00:00:00Z');
    const now = unixSeconds('2026-01-07T12:34:56Z');
    const request = fakeFetch(async () => jsonResponse(page([
      bucket(monday, [cost(providerKeyId, 0.1)]),
      bucket(monday + daySeconds, [cost(providerKeyId, 0.2), cost('key_other', 99)]),
      bucket(wednesday, [cost(providerKeyId, 0.345), cost(providerKeyId, 0.005)])
    ])));

    const result = await spendService(now, request).read('local');

    expect(result.status).toBe('available');
    // verify unrounded provider precision
    if (result.status === 'available') {
      expect(result.todayUsd).toBeCloseTo(0.35, 12);
      expect(result.weekUsd).toBeCloseTo(0.65, 12);
      expect(result.asOf).toBe(now);
    }
  });

  it('accepts a current daily bucket ending at the exact query end', async () => {
    const today = unixSeconds('2026-01-07T00:00:00Z');
    const now = unixSeconds('2026-01-07T12:34:56Z');
    const request = fakeFetch(async () => jsonResponse(page([bucket(today, [cost(providerKeyId, 1.25)], now)])));

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'available', todayUsd: 1.25, weekUsd: 1.25, asOf: now });
  });

  it('treats an empty valid costs page as zero spend', async () => {
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const request = fakeFetch(async () => jsonResponse(page([])));

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'available', todayUsd: 0, weekUsd: 0, asOf: now });
  });

  it('avoids an invalid empty-range request at exact monday midnight', async () => {
    const now = unixSeconds('2026-01-05T00:00:00Z');
    const request = fakeFetch(async () => jsonResponse(page([])));

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'available', todayUsd: 0, weekUsd: 0, asOf: now });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('ApiKeySpendService response safety', () => {
  // exercise malformed envelopes, rows, money, and time boundaries
  it.each([
    ['wrong page object', { object: 'list', data: [], has_more: false, next_page: null }],
    ['missing page cursor state', { object: 'page', data: [], has_more: false }],
    ['wrong bucket object', page([{ object: 'cost', start_time: unixSeconds('2026-01-05T00:00:00Z'), end_time: unixSeconds('2026-01-06T00:00:00Z'), results: [] }])],
    ['unaligned bucket', page([bucket(unixSeconds('2026-01-05T00:00:01Z'), [])])],
    ['ambiguous bucket end', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [], unixSeconds('2026-01-05T12:00:00Z'))])],
    ['missing attribution', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [cost(null, 1)])])],
    ['wrong result object', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [{ ...cost(providerKeyId, 1), object: 'cost' }])])],
    ['missing amount', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [{ object: 'organization.costs.result', api_key_id: providerKeyId }])])],
    ['non-usd amount', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [cost(providerKeyId, 1, 'eur')])])],
    ['non-finite amount representation', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [cost(providerKeyId, 'NaN')])])],
    ['overflowing total', page([bucket(unixSeconds('2026-01-05T00:00:00Z'), [cost(providerKeyId, Number.MAX_VALUE), cost(providerKeyId, Number.MAX_VALUE)])])]
  ])('fails the whole result for %s', async (_name, payload) => {
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const request = fakeFetch(async () => jsonResponse(payload));

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'unavailable' });
  });

  it('fails safely for provider status, invalid json, and oversized responses', async () => {
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const failing = [
      new Response(JSON.stringify({ error: 'secret provider details' }), { status: 401 }),
      new Response('{not json', { status: 200 }),
      new Response('{}', { status: 200, headers: { 'content-length': String(256 * 1024 + 1) } })
    ];
    // isolate every terminal provider failure
    for (const response of failing) {
      const request = fakeFetch(async () => response);
      await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'unavailable' });
    }
  });

  it('does not expose provider credentials or billing ids when a request fails', async () => {
    const secret = 'admin-secret-that-must-not-escape';
    const billingId = 'key_billing-id-that-must-not-escape';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const request = fakeFetch(async () => { throw new Error(`${secret}:${billingId}`); });
    const service = new ApiKeySpendService({ adminKey: secret, keyIds: { local: billingId }, fetch: request, now: () => Date.parse('2026-01-07T12:00:00Z') });

    const result = await service.read('local');

    expect(result).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(billingId);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('times out the entire query and aborts its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = fakeFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    });
    const pending = spendService(unixSeconds('2026-01-07T12:00:00Z'), request).read('local');

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(signal?.aborted).toBe(true);
  });
});

describe('ApiKeySpendService pagination and caching', () => {
  it('paginates with an opaque cursor and totals only after the terminal page', async () => {
    const monday = unixSeconds('2026-01-05T00:00:00Z');
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const request = fakeFetch(async input => {
      const url = new URL(String(input));
      // return the terminal page only for the supplied cursor
      if (url.searchParams.get('page') === 'cursor-two') return jsonResponse(page([bucket(monday + daySeconds, [cost(providerKeyId, 2)])]));
      return jsonResponse(page([bucket(monday, [cost(providerKeyId, 1)])], 'cursor-two'));
    });

    await expect(spendService(now, request).read('local')).resolves.toEqual({ status: 'available', todayUsd: 0, weekUsd: 3, asOf: now });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects repeated cursors and duplicate buckets without partial totals', async () => {
    const monday = unixSeconds('2026-01-05T00:00:00Z');
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const repeatedCursor = fakeFetch(async input => {
      const current = new URL(String(input)).searchParams.get('page');
      return jsonResponse(page(current === null ? [bucket(monday, [cost(providerKeyId, 1)])] : [bucket(monday + daySeconds, [cost(providerKeyId, 2)])], 'same-cursor'));
    });
    const duplicateBucket = fakeFetch(async input => {
      const current = new URL(String(input)).searchParams.get('page');
      return jsonResponse(page([bucket(monday, [cost(providerKeyId, current === null ? 1 : 2)])], current === null ? 'next' : null));
    });

    await expect(spendService(now, repeatedCursor).read('local')).resolves.toEqual({ status: 'unavailable' });
    await expect(spendService(now, duplicateBucket).read('local')).resolves.toEqual({ status: 'unavailable' });
    expect(repeatedCursor).toHaveBeenCalledTimes(2);
    expect(duplicateBucket).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent aliases and reuses their provider-key cache', async () => {
    const now = unixSeconds('2026-01-07T12:00:00Z');
    let release: ((response: Response) => void) | undefined;
    const request = fakeFetch(async () => await new Promise<Response>(resolve => { release = resolve; }));
    const service = spendService(now, request, { first: providerKeyId, second: providerKeyId });

    const first = service.read('first');
    const second = service.read('second');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release?.(jsonResponse(page([])));

    await expect(first).resolves.toMatchObject({ status: 'available' });
    await expect(second).resolves.toMatchObject({ status: 'available' });
    await expect(service.read('first')).resolves.toMatchObject({ status: 'available' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('isolates different provider keys and never includes their ids in results', async () => {
    const now = unixSeconds('2026-01-07T12:00:00Z');
    const today = unixSeconds('2026-01-07T00:00:00Z');
    const request = fakeFetch(async input => {
      const keyId = new URL(String(input)).searchParams.get('api_key_ids[]');
      return jsonResponse(page([bucket(today, [cost(keyId, keyId === 'key_first' ? 1 : 2)])]));
    });
    const service = spendService(now, request, { first: 'key_first', second: 'key_second' });

    const [first, second] = await Promise.all([service.read('first'), service.read('second')]);

    expect(first).toMatchObject({ status: 'available', todayUsd: 1, weekUsd: 1 });
    expect(second).toMatchObject({ status: 'available', todayUsd: 2, weekUsd: 2 });
    expect(JSON.stringify([first, second])).not.toContain('key_first');
    expect(JSON.stringify([first, second])).not.toContain('key_second');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('expires cache entries at the utc day boundary even before sixty seconds', async () => {
    let now = Date.parse('2026-01-07T23:59:30Z');
    const request = fakeFetch(async () => jsonResponse(page([])));
    const service = new ApiKeySpendService({ adminKey, keyIds: { local: providerKeyId }, fetch: request, now: () => now });

    await service.read('local');
    now = Date.parse('2026-01-07T23:59:50Z');
    await service.read('local');
    expect(request).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-01-08T00:00:01Z');
    await service.read('local');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('expires successful entries after at most sixty seconds', async () => {
    let now = Date.parse('2026-01-07T12:00:00Z');
    const request = fakeFetch(async () => jsonResponse(page([])));
    const service = new ApiKeySpendService({ adminKey, keyIds: { local: providerKeyId }, fetch: request, now: () => now });

    await service.read('local');
    now += 59_999;
    await service.read('local');
    expect(request).toHaveBeenCalledTimes(1);
    now += 1;
    await service.read('local');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('briefly caches provider failures without making them available', async () => {
    let now = Date.parse('2026-01-07T12:00:00Z');
    let calls = 0;
    const request = fakeFetch(async () => {
      calls += 1;
      // fail only the first upstream attempt
      if (calls === 1) return new Response(null, { status: 503 });
      return jsonResponse(page([]));
    });
    const service = new ApiKeySpendService({ adminKey, keyIds: { local: providerKeyId }, fetch: request, now: () => now });

    await expect(service.read('local')).resolves.toEqual({ status: 'unavailable' });
    await expect(service.read('local')).resolves.toEqual({ status: 'unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
    now += 5_000;
    await expect(service.read('local')).resolves.toMatchObject({ status: 'available' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
