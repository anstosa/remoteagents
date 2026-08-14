import { describe, expect, it } from 'vitest';
import { federationForwarder, verifyFederationRequest, type FederationPayload } from '../src/integrations/federation/index.js';

const secret = Buffer.alloc(32, 9).toString('base64url');

describe('integration federation', () => {
  it('forwards delegated scopes without forwarding a bearer token', async () => {
    let verified: FederationPayload | undefined;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const payload = JSON.parse(String(init?.body)) as unknown;
      verified = verifyFederationRequest(secret, headers.get('x-rac-federation-timestamp'), headers.get('x-rac-federation-signature'), payload);
      expect(headers.has('authorization')).toBe(false);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }), { status: 200 });
    };
    const forward = federationForwarder([{ name: 'Peer', url: new URL('https://peer.example.com') }], secret, fetcher as typeof fetch);
    const result = await forward('https://peer.example.com', { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: 'https://local.example.com/mcp', scopes: ['status:read'] }, 'list_agents', {}, false);
    expect(result?.structuredContent).toEqual({ ok: true });
    expect(verified).toMatchObject({ principal: { subjectId: 'user', clientId: 'chatgpt', scopes: ['status:read'] }, name: 'list_agents', voiceAuthorized: false });
  });

  it('rejects stale and altered federation requests', () => {
    const payload = { principal: { subjectId: 'user', scopes: ['status:read'] }, name: 'list_agents', arguments: {}, voiceAuthorized: false };
    expect(verifyFederationRequest(secret, String(Date.now() - 60_000), 'bad', payload)).toBeUndefined();
    expect(verifyFederationRequest(secret, String(Date.now()), 'bad', payload)).toBeUndefined();
  });
});
