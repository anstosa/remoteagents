import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RemoteServer } from './config/schema.js';
import type { DashboardPayload } from './dashboard/updates.js';
import { agentAttentionState } from './notifications.js';

export type InstanceAttention = 'idle' | 'working' | 'question' | 'completed' | 'unavailable';
export type InstanceStatus = { url: string; attention: InstanceAttention };

const statusClockSkewMs = 30_000;
const statusResponseBytes = 1_024;
const statusCacheMs = 5_000;

// reduce dashboard details to one safe attention state
export function instanceAttention(dashboard: Pick<DashboardPayload, 'agents'>): Exclude<InstanceAttention, 'unavailable'> {
  // prioritize active questions over completed notifications
  if (dashboard.agents.some(agent => agentAttentionState(agent) === 'question')) return 'question';
  // show active work before any retained completion notification
  if (dashboard.agents.some(agent => agentAttentionState(agent) === 'working')) return 'working';
  // retain completed state until its notification is viewed
  if (dashboard.agents.some(agent => agent.unread)) return 'completed';
  return 'idle';
}

// derive one domain-separated peer signature
function instanceStatusSignature(secret: string, targetOrigin: string, timestamp: string): Buffer {
  return createHmac('sha256', secret).update(`rac-instance-status-v1\n${targetOrigin}\n${timestamp}`).digest();
}

// build authenticated peer request headers
function instanceStatusHeaders(secret: string, targetOrigin: string): Record<string, string> {
  const timestamp = String(Date.now());
  return { accept: 'application/json', 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': instanceStatusSignature(secret, targetOrigin, timestamp).toString('base64url') };
}

// authenticate one peer status request
export function validInstanceStatusRequest(secret: string, targetOrigin: string, timestamp: unknown, signature: unknown, now = Date.now()): boolean {
  // require the server-only shared secret and header shape
  if (secret.length < 32 || typeof timestamp !== 'string' || typeof signature !== 'string' || !/^\d{13}$/u.test(timestamp)) return false;
  const requestedAt = Number(timestamp);
  // reject stale or future replay windows
  if (!Number.isSafeInteger(requestedAt) || Math.abs(now - requestedAt) > statusClockSkewMs) return false;
  let provided: Buffer;
  // reject malformed signature encodings
  try { provided = Buffer.from(signature, 'base64url'); }
  catch { return false; }
  const expected = instanceStatusSignature(secret, targetOrigin, timestamp);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// validate a remote status response
function isInstanceAttention(value: unknown): value is Exclude<InstanceAttention, 'unavailable'> {
  return value === 'idle' || value === 'working' || value === 'question' || value === 'completed';
}

// read one deliberately small peer response
async function boundedResponseText(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  // reject declared oversize responses before streaming
  if (Number.isFinite(declaredLength) && declaredLength > statusResponseBytes) return undefined;
  // accept an empty response stream for validation
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    // stop reading at the fixed protocol limit
    while (true) {
      const chunk = await reader.read();
      // flush the decoder after the stream ends
      if (chunk.done) return `${text}${decoder.decode()}`;
      bytes += chunk.value.byteLength;
      // cancel an oversized or dishonest response
      if (bytes > statusResponseBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// query one configured instance without browser credentials
async function remoteInstanceStatus(server: RemoteServer, secret: string): Promise<InstanceStatus> {
  try {
    const response = await fetch(new URL('/api/instance-status', server.url), { headers: instanceStatusHeaders(secret, server.url.origin), redirect: 'error', signal: AbortSignal.timeout(4_000) });
    // reject non-successful remote responses
    if (!response.ok) return { url: server.url.origin, attention: 'unavailable' };
    const serialized = await boundedResponseText(response);
    // reject oversized remote responses
    if (serialized === undefined) return { url: server.url.origin, attention: 'unavailable' };
    const payload: unknown = JSON.parse(serialized);
    // reject malformed remote responses
    if (payload === null || typeof payload !== 'object' || !isInstanceAttention((payload as { attention?: unknown }).attention)) return { url: server.url.origin, attention: 'unavailable' };
    return { url: server.url.origin, attention: (payload as { attention: Exclude<InstanceAttention, 'unavailable'> }).attention };
  } catch {
    return { url: server.url.origin, attention: 'unavailable' };
  }
}

// coalesce identical peer polls across browser sessions
export class RemoteInstanceStatusPoller {
  private readonly cached = new Map<string, { expiresAt: number; status: InstanceStatus }>();
  private readonly pending = new Map<string, Promise<InstanceStatus>>();

  constructor(private readonly secret: string) {}

  // query every configured peer with shared cache entries
  async statuses(servers: RemoteServer[]): Promise<InstanceStatus[]> {
    return await Promise.all(servers.map(async server => await this.status(server)));
  }

  // reuse one fresh or in-flight peer result
  private async status(server: RemoteServer): Promise<InstanceStatus> {
    const cached = this.cached.get(server.url.origin);
    // reuse the current five-second result
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
    const pending = this.pending.get(server.url.origin);
    // join an identical active poll
    if (pending !== undefined) return await pending;
    const refresh = remoteInstanceStatus(server, this.secret).then(status => {
      this.cached.set(server.url.origin, { expiresAt: Date.now() + statusCacheMs, status });
      return status;
    }).finally(() => {
      // remove only the completed refresh
      if (this.pending.get(server.url.origin) === refresh) this.pending.delete(server.url.origin);
    });
    this.pending.set(server.url.origin, refresh);
    return await refresh;
  }
}
