import { record, safeAccountId } from './validation.js';

export type ApiKeySpend =
  | { status: 'available'; todayUsd: number; weekUsd: number; asOf: number }
  | { status: 'unconfigured' | 'unavailable' };

export type ApiKeySpendServiceOptions = {
  adminKey?: string;
  keyIds?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

type SpendBoundaries = {
  asOf: number;
  observedAt: number;
  todayStart: number;
  tomorrowStart: number;
  weekStart: number;
};

type SpendTotals = { todayUsd: number; weekUsd: number };
type CachedSpend = { dayStart: number; expiresAt: number; value: ApiKeySpend };
type PendingSpend = { dayStart: number; value: Promise<ApiKeySpend> };
type ParsedResponse = { value: unknown; bytes: number };
type ParsedPage = SpendTotals & { nextPage?: string };

const costsEndpoint = 'https://api.openai.com/v1/organization/costs';
const daySeconds = 24 * 60 * 60;
const requestTimeoutMs = 8_000;
const availableCacheMs = 60_000;
const unavailableCacheMs = 5_000;
const maxResponseBytes = 256 * 1024;
const maxPages = 10;
const maxCursorLength = 4_096;
const maxProviderKeyIdLength = 512;
const maxAdminKeyLength = 8_192;

// validate one opaque scalar without exposing it
function opaqueScalar(value: unknown, maxLength: number): string | undefined {
  // require bounded printable text with no normalization ambiguity
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

// validate an admin credential supplied only through spend configuration
function adminCredential(value: unknown): string | undefined {
  return opaqueScalar(value, maxAdminKeyLength);
}

// validate the complete local-to-provider mapping
function keyIdMapping(value: unknown): Readonly<Record<string, string>> | undefined {
  const source = record(value);
  // reject missing or non-object configuration
  if (source === undefined) return undefined;
  const mapped: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(source);
  // reject unexpectedly large operator configuration
  if (entries.length > 10_000) return undefined;
  // validate every mapping before accepting any of it
  for (const [accountId, providerKeyIdValue] of entries) {
    const providerKeyId = opaqueScalar(providerKeyIdValue, maxProviderKeyIdLength);
    // reject unsafe local identifiers and ambiguous provider identifiers
    if (!safeAccountId.test(accountId) || providerKeyId === undefined) return undefined;
    mapped[accountId] = providerKeyId;
  }
  return Object.freeze(mapped);
}

// parse the environment mapping without surfacing its contents
function environmentKeyIds(serialized: string | undefined): Readonly<Record<string, string>> | undefined {
  // reject missing configuration before parsing
  if (serialized === undefined) return undefined;
  try {
    return keyIdMapping(JSON.parse(serialized) as unknown);
  } catch {
    return undefined;
  }
}

// derive exact utc day and monday boundaries
function spendBoundaries(observedAt: number): SpendBoundaries | undefined {
  // reject clocks that cannot produce safe unix seconds
  if (!Number.isFinite(observedAt) || observedAt < 0) return undefined;
  const asOf = Math.floor(observedAt / 1_000);
  // reject unsafe or out-of-range timestamps
  if (!Number.isSafeInteger(asOf)) return undefined;
  const todayStart = Math.floor(asOf / daySeconds) * daySeconds;
  const utcDay = new Date(todayStart * 1_000).getUTCDay();
  // reject dates outside the javascript date range
  if (!Number.isInteger(utcDay)) return undefined;
  const daysSinceMonday = (utcDay + 6) % 7;
  return { asOf, observedAt, todayStart, tomorrowStart: todayStart + daySeconds, weekStart: todayStart - daysSinceMonday * daySeconds };
}

// construct one fixed-origin costs request
function costsUrl(boundaries: SpendBoundaries, providerKeyId: string, page?: string): URL {
  const url = new URL(costsEndpoint);
  url.searchParams.set('start_time', String(boundaries.weekStart));
  url.searchParams.set('end_time', String(boundaries.asOf));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', '7');
  url.searchParams.append('api_key_ids[]', providerKeyId);
  url.searchParams.append('group_by[]', 'api_key_id');
  // append only a provider-issued cursor
  if (page !== undefined) url.searchParams.set('page', page);
  return url;
}

// read one response under a cumulative byte allowance
async function boundedJson(response: Response, allowance: number): Promise<ParsedResponse> {
  const declared = response.headers.get('content-length');
  // reject malformed, negative, or oversized declared lengths
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > allowance)) throw new Error();
  // require an actual json response body
  if (response.body === null) throw new Error();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let serialized = '';
  let bytes = 0;
  try {
    // stream without allocating beyond the protocol bound
    while (true) {
      const chunk = await reader.read();
      // finish and parse the bounded payload
      if (chunk.done) {
        serialized += decoder.decode();
        return { value: JSON.parse(serialized) as unknown, bytes };
      }
      bytes += chunk.value.byteLength;
      // cancel dishonest or oversized responses
      if (bytes > allowance) {
        await reader.cancel();
        throw new Error();
      }
      serialized += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// validate one pagination cursor
function paginationCursor(value: unknown): string | undefined {
  return opaqueScalar(value, maxCursorLength);
}

// validate and total one costs page
function parseCostsPage(value: unknown, providerKeyId: string, boundaries: SpendBoundaries, seenBuckets: Set<number>): ParsedPage {
  const page = record(value);
  // require the documented page envelope
  if (page === undefined || page.object !== 'page' || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new Error();
  // preserve the requested seven-bucket page bound
  if (page.data.length > 7) throw new Error();
  let todayUsd = 0;
  let weekUsd = 0;
  // validate every bucket before making totals available
  for (const bucketValue of page.data) {
    const bucket = record(bucketValue);
    // require documented bucket fields
    if (bucket === undefined || bucket.object !== 'bucket' || !Number.isSafeInteger(bucket.start_time) || !Number.isSafeInteger(bucket.end_time) || !Array.isArray(bucket.results)) throw new Error();
    const startTime = bucket.start_time as number;
    const endTime = bucket.end_time as number;
    const dailyEnd = startTime + daySeconds;
    const queryEnd = Math.min(dailyEnd, boundaries.asOf);
    // require one unique utc-aligned bucket inside the exact query range
    if (startTime % daySeconds !== 0 || startTime < boundaries.weekStart || startTime >= boundaries.asOf || endTime <= startTime || (endTime !== dailyEnd && endTime !== queryEnd) || seenBuckets.has(startTime)) throw new Error();
    seenBuckets.add(startTime);
    // validate every attributed cost result
    for (const resultValue of bucket.results) {
      const result = record(resultValue);
      // require a costs result with explicit attribution
      if (result === undefined || result.object !== 'organization.costs.result' || opaqueScalar(result.api_key_id, maxProviderKeyIdLength) === undefined) throw new Error();
      // ignore defensively returned costs for a different key
      if (result.api_key_id !== providerKeyId) continue;
      const amount = record(result.amount);
      // reject missing, non-finite, or non-usd monetary data
      if (amount === undefined || amount.currency !== 'usd' || typeof amount.value !== 'number' || !Number.isFinite(amount.value)) throw new Error();
      weekUsd += amount.value;
      // count only the current utc day in today's total
      if (startTime === boundaries.todayStart) todayUsd += amount.value;
      // reject arithmetic overflow instead of publishing invalid totals
      if (!Number.isFinite(todayUsd) || !Number.isFinite(weekUsd)) throw new Error();
    }
  }
  // require cursor state consistent with the documented envelope
  if (!page.has_more) {
    if (page.next_page !== null) throw new Error();
    return { todayUsd, weekUsd };
  }
  const nextPage = paginationCursor(page.next_page);
  // require a usable cursor for another page
  if (nextPage === undefined) throw new Error();
  return { todayUsd, weekUsd, nextPage };
}

// read exact per-key spend with bounded caching and provider access
export class ApiKeySpendService {
  private readonly adminKey: string | undefined;
  private readonly keyIds: Readonly<Record<string, string>> | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cached = new Map<string, CachedSpend>();
  private readonly pending = new Map<string, PendingSpend>();

  // capture configuration once for this service instance
  constructor(options: ApiKeySpendServiceOptions = {}) {
    this.adminKey = adminCredential(options.adminKey === undefined ? process.env.RAC_OPENAI_ADMIN_KEY : options.adminKey);
    this.keyIds = options.keyIds === undefined ? environmentKeyIds(process.env.RAC_OPENAI_API_KEY_IDS) : keyIdMapping(options.keyIds);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  // return spend for one explicitly mapped local account
  async read(id: string): Promise<ApiKeySpend> {
    // avoid all network access without complete valid configuration
    if (this.adminKey === undefined || this.keyIds === undefined) return { status: 'unconfigured' };
    const providerKeyId = this.keyIds[id];
    // require an explicit mapping for this local account
    if (providerKeyId === undefined) return { status: 'unconfigured' };
    let boundaries: SpendBoundaries | undefined;
    try {
      boundaries = spendBoundaries(this.now());
    } catch {
      return { status: 'unavailable' };
    }
    // reject an unusable injected clock
    if (boundaries === undefined) return { status: 'unavailable' };
    const cached = this.cached.get(providerKeyId);
    // reuse only a fresh result from the same utc day
    if (cached !== undefined && cached.dayStart === boundaries.todayStart && cached.expiresAt > boundaries.observedAt) return cached.value;
    const pending = this.pending.get(providerKeyId);
    // deduplicate only the same provider key and utc day
    if (pending !== undefined && pending.dayStart === boundaries.todayStart) return await pending.value;
    const refresh = this.refresh(providerKeyId, boundaries).catch((): ApiKeySpend => ({ status: 'unavailable' }));
    const value = refresh.then(result => {
      const ttl = result.status === 'available' ? availableCacheMs : unavailableCacheMs;
      const entry = { dayStart: boundaries.todayStart, expiresAt: Math.min(boundaries.observedAt + ttl, boundaries.tomorrowStart * 1_000), value: result };
      const current = this.cached.get(providerKeyId);
      // prevent an old-day request from overwriting a newer-day result
      if (current === undefined || current.dayStart <= boundaries.todayStart) this.cached.set(providerKeyId, entry);
      return result;
    });
    this.pending.set(providerKeyId, { dayStart: boundaries.todayStart, value });
    try {
      return await value;
    } finally {
      const current = this.pending.get(providerKeyId);
      // remove only this completed in-flight query
      if (current?.value === value) this.pending.delete(providerKeyId);
    }
  }

  // query the whole elapsed utc week under one deadline
  private async refresh(providerKeyId: string, boundaries: SpendBoundaries): Promise<ApiKeySpend> {
    // avoid an invalid empty-range request at monday midnight
    if (boundaries.weekStart === boundaries.asOf) return { status: 'available', todayUsd: 0, weekUsd: 0, asOf: boundaries.asOf };
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error());
      }, requestTimeoutMs);
      // do not retain the node process only for an upstream deadline
      timeout.unref();
    });
    try {
      const totals = await Promise.race([this.fetchTotals(providerKeyId, boundaries, controller.signal), deadline]);
      return { status: 'available', ...totals, asOf: boundaries.asOf };
    } finally {
      // release the deadline after every terminal outcome
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }

  // fetch and validate every costs page
  private async fetchTotals(providerKeyId: string, boundaries: SpendBoundaries, signal: AbortSignal): Promise<SpendTotals> {
    const seenCursors = new Set<string>();
    const seenBuckets = new Set<number>();
    let page: string | undefined;
    let remainingBytes = maxResponseBytes;
    let todayUsd = 0;
    let weekUsd = 0;
    // bound provider pagination independently of cursors
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const response = await this.fetcher(costsUrl(boundaries, providerKeyId, page), {
        headers: { accept: 'application/json', authorization: `Bearer ${this.adminKey}` },
        redirect: 'error',
        signal
      });
      // reject every non-success response without parsing provider errors
      if (!response.ok) throw new Error();
      const parsed = await boundedJson(response, remainingBytes);
      remainingBytes -= parsed.bytes;
      const totals = parseCostsPage(parsed.value, providerKeyId, boundaries, seenBuckets);
      todayUsd += totals.todayUsd;
      weekUsd += totals.weekUsd;
      // reject arithmetic overflow across pages
      if (!Number.isFinite(todayUsd) || !Number.isFinite(weekUsd)) throw new Error();
      // return only after a fully validated terminal page
      if (totals.nextPage === undefined) return { todayUsd, weekUsd };
      // reject repeated cursors before another network request
      if (seenCursors.has(totals.nextPage)) throw new Error();
      seenCursors.add(totals.nextPage);
      page = totals.nextPage;
    }
    throw new Error();
  }
}
