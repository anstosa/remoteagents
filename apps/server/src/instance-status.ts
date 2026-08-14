import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RemoteServer } from './config/schema.js';
import type { Agent } from './domain/models.js';
import { isInstanceIcon, type InstanceIcon } from './instance-icon.js';
import { agentAttentionState } from './notifications.js';

export type InstanceAttention = 'idle' | 'working' | 'question' | 'completed' | 'unavailable';
export type InstanceStatus = { url: string; name: string; icon?: InstanceIcon; attention: InstanceAttention };
type PublishedIdentity = Pick<InstanceStatus, 'name' | 'icon'>;

const statusClockSkewMs = 30_000;
const statusResponseBytes = 2_048;
const legacyMetadataResponseBytes = 8_192;
const statusCacheMs = 5_000;

// reduce dashboard details to one safe attention state
export function instanceAttention(dashboard: { agents: Array<Agent & { unread: boolean }> }): Exclude<InstanceAttention, 'unavailable'> {
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

// validate one bounded published identity
function publishedIdentity(value: unknown): PublishedIdentity | undefined {
  // require one metadata object
  if (value === null || typeof value !== 'object') return undefined;
  const metadata = value as { name?: unknown; icon?: unknown };
  // require a safe name and bundled icon
  if (typeof metadata.name !== 'string' || metadata.name !== metadata.name.trim() || metadata.name.length === 0 || metadata.name.length > 80 || metadata.name.includes('\0') || (metadata.icon !== undefined && (typeof metadata.icon !== 'string' || !isInstanceIcon(metadata.icon)))) return undefined;
  return { name: metadata.name, ...(metadata.icon === undefined ? {} : { icon: metadata.icon }) };
}

// provide stable navigation while a peer is unavailable
function unavailableStatus(server: RemoteServer): InstanceStatus {
  return { url: server.url.origin, name: server.url.hostname, attention: 'unavailable' };
}

// query identity from pre-metadata peers
async function legacyPublishedIdentity(server: RemoteServer): Promise<PublishedIdentity | undefined> {
  try {
    const response = await fetch(new URL('/api/auth/bootstrap', server.url), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(4_000) });
    // reject unsuccessful legacy responses
    if (!response.ok) return undefined;
    const serialized = await boundedResponseText(response, legacyMetadataResponseBytes);
    // reject oversized legacy responses
    if (serialized === undefined) return undefined;
    const payload: unknown = JSON.parse(serialized);
    // require a matching self-published origin
    if (payload === null || typeof payload !== 'object' || (payload as { server?: { url?: unknown } }).server?.url !== server.url.origin) return undefined;
    return publishedIdentity((payload as { server: unknown }).server);
  } catch {
    return undefined;
  }
}

// read one deliberately small peer response
async function boundedResponseText(response: Response, maxBytes = statusResponseBytes): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  // reject declared oversize responses before streaming
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
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
      if (bytes > maxBytes) {
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
async function remoteInstanceStatus(server: RemoteServer, secret: string, known?: PublishedIdentity): Promise<InstanceStatus> {
  try {
    const response = await fetch(new URL('/api/instance-status', server.url), { headers: instanceStatusHeaders(secret, server.url.origin), redirect: 'error', signal: AbortSignal.timeout(4_000) });
    // reject non-successful remote responses
    if (!response.ok) return unavailableStatus(server);
    const serialized = await boundedResponseText(response);
    // reject oversized remote responses
    if (serialized === undefined) return unavailableStatus(server);
    const payload: unknown = JSON.parse(serialized);
    // reject malformed remote responses
    if (payload === null || typeof payload !== 'object' || !isInstanceAttention((payload as { attention?: unknown }).attention)) return unavailableStatus(server);
    const attention = (payload as { attention: Exclude<InstanceAttention, 'unavailable'> }).attention;
    const identity = publishedIdentity(payload) ?? known ?? await legacyPublishedIdentity(server) ?? { name: server.url.hostname };
    return { url: server.url.origin, name: identity.name, ...(identity.icon === undefined ? {} : { icon: identity.icon }), attention };
  } catch {
    return unavailableStatus(server);
  }
}

// coalesce identical peer polls across browser sessions
export class RemoteInstanceStatusPoller {
  private readonly cached = new Map<string, { expiresAt: number; status: InstanceStatus }>();
  private readonly pending = new Map<string, Promise<InstanceStatus>>();
  private readonly identities = new Map<string, Pick<InstanceStatus, 'name' | 'icon'>>();

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
    const refresh = remoteInstanceStatus(server, this.secret, this.identities.get(server.url.origin)).then(received => {
      const known = this.identities.get(server.url.origin);
      const status = received.attention === 'unavailable' && known !== undefined ? { url: received.url, name: known.name, ...(known.icon === undefined ? {} : { icon: known.icon }), attention: received.attention } : received;
      // retain the last published identity across outages
      if (status.attention !== 'unavailable') this.identities.set(server.url.origin, { name: status.name, ...(status.icon === undefined ? {} : { icon: status.icon }) });
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
