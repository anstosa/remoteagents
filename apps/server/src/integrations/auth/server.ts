import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IntegrationAuthService } from './service.js';
import type { AuthorizationRequest, DynamicClientRegistrationRequest, LocalIntegrationSubject, OAuthFailure } from './types.js';

export type IntegrationAuthServerOptions = {
  app: FastifyInstance;
  auth: IntegrationAuthService;
  resource: string;
  localSubject: (request: FastifyRequest, csrf?: string) => LocalIntegrationSubject | undefined;
};

// register OAuth discovery, consent, registration, and token endpoints
export function registerIntegrationAuthServer(options: IntegrationAuthServerOptions): void {
  const expectedHost = new URL(options.resource).host;
  // bind every OAuth route to the configured public authority
  options.app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    // leave unrelated browser and API routes unchanged
    if (!path.startsWith('/oauth/') && !path.startsWith('/.well-known/oauth-')) return;
    // reject alternate authorities
    if (request.headers.host !== expectedHost) return reply.code(403).send({ error: 'forbidden' });
  });
  // parse standards-based form submissions without another dependency
  if (!options.app.hasContentTypeParser('application/x-www-form-urlencoded')) options.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); }
    catch (error) { done(error as Error); }
  });
  options.app.get('/.well-known/oauth-protected-resource', async () => options.auth.protectedResourceMetadata());
  options.app.get('/.well-known/oauth-protected-resource/mcp', async () => options.auth.protectedResourceMetadata());
  options.app.get('/.well-known/oauth-authorization-server', async () => options.auth.authorizationServerMetadata());
  options.app.post('/oauth/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = await options.auth.registerClient((request.body ?? {}) as DynamicClientRegistrationRequest);
    return result.ok ? reply.code(201).send(result.value) : oauthError(reply, result);
  });
  options.app.get('/oauth/authorize', async (request, reply) => {
    const subject = options.localSubject(request);
    // require the existing local browser login before consent
    if (subject === undefined) return reply.code(401).type('text/html').send(consentError('Sign in to Remote Agents first, then retry this connection.'));
    const query = stringRecord(request.query);
    const csrf = (subject as LocalIntegrationSubject & { csrf?: string }).csrf;
    return reply.type('text/html').send(consentPage(query, csrf ?? ''));
  });
  options.app.post('/oauth/authorize', async (request, reply) => {
    const form = stringRecord(request.body);
    const subject = options.localSubject(request, form.csrf);
    // require the same authenticated local browser for approval
    if (subject === undefined) return reply.code(401).type('text/html').send(consentError('Your Remote Agents session is unavailable.'));
    const authorization = authorizationRequest(form, options.resource);
    // reject incomplete authorization requests locally
    if (authorization === undefined) return reply.code(400).type('text/html').send(consentError('The authorization request is invalid.'));
    const result = await options.auth.authorize(authorization, subject);
    // display safe OAuth failures without following untrusted redirects
    if (!result.ok) return reply.code(result.status).type('text/html').send(consentError(result.error_description));
    const redirect = new URL(result.value.redirect_uri);
    redirect.searchParams.set('code', result.value.code);
    // preserve the client's anti-forgery state
    if (result.value.state !== undefined) redirect.searchParams.set('state', result.value.state);
    return reply.redirect(redirect.toString());
  });
  options.app.post('/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const form = stringRecord(request.body);
    // route only supported token grants
    if (form.grant_type === 'authorization_code') {
      const result = await options.auth.exchangeCode({ grant_type: 'authorization_code', client_id: form.client_id ?? '', code: form.code ?? '', redirect_uri: form.redirect_uri ?? '', code_verifier: form.code_verifier ?? '', resource: form.resource ?? '' });
      return result.ok ? reply.send(result.value) : oauthError(reply, result);
    }
    // rotate one valid refresh grant
    if (form.grant_type === 'refresh_token') {
      const result = await options.auth.refresh({ grant_type: 'refresh_token', client_id: form.client_id ?? '', refresh_token: form.refresh_token ?? '', resource: form.resource ?? '', ...(form.scope === undefined ? {} : { scope: form.scope }) });
      return result.ok ? reply.send(result.value) : oauthError(reply, result);
    }
    return oauthError(reply, { ok: false, error: 'unsupported_grant_type', error_description: 'Only authorization_code and refresh_token are supported.', status: 400 });
  });
  options.app.post('/oauth/revoke', async (request, reply) => {
    const token = stringRecord(request.body).token;
    // preserve idempotent RFC 7009 behavior
    if (token !== undefined) await options.auth.revokeRefreshToken(token);
    return reply.code(200).send();
  });
}

// coerce only string form and query fields
function stringRecord(value: unknown): Record<string, string> {
  // ignore non-object parser output
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

// construct the exact supported authorization profile
function authorizationRequest(value: Record<string, string>, resource: string): AuthorizationRequest | undefined {
  // require every OAuth and PKCE binding
  if (value.response_type !== 'code' || value.code_challenge_method !== 'S256' || value.resource !== resource || value.client_id === undefined || value.redirect_uri === undefined || value.scope === undefined || value.code_challenge === undefined) return undefined;
  return { response_type: 'code', client_id: value.client_id, redirect_uri: value.redirect_uri, resource: value.resource, scope: value.scope, code_challenge: value.code_challenge, code_challenge_method: 'S256', ...(value.state === undefined ? {} : { state: value.state }) };
}

// render a same-origin explicit consent form
function consentPage(query: Record<string, string>, csrf: string): string {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'resource', 'scope', 'code_challenge', 'code_challenge_method', 'state']
    .filter(name => query[name] !== undefined)
    .map(name => `<input type="hidden" name="${name}" value="${escapeHtml(query[name] ?? '')}">`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Remote Agents</title><style>body{font:16px system-ui;background:#0b0d10;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:34rem;padding:2rem;background:#171a20;border:1px solid #3a414c;border-radius:1rem}button{font:inherit;padding:.75rem 1rem;border:0;border-radius:.6rem;background:#7ee787;color:#08100a;font-weight:700}code{overflow-wrap:anywhere;color:#a5d6ff}</style></head><body><main class="card"><h1>Connect Remote Agents</h1><p>This client is requesting access to <code>${escapeHtml(query.scope ?? '')}</code>.</p><p>Only configured tools are exposed. Arbitrary shell and terminal access are not available.</p><form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Authorize connection</button></form></main></body></html>`;
}

// render one inert authorization error page
function consentError(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Remote Agents authorization</title></head><body><h1>Connection unavailable</h1><p>${escapeHtml(message)}</p></body></html>`;
}

// escape user-controlled values before HTML rendering
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

// send one OAuth error response without implementation details
function oauthError(reply: FastifyReply, failure: OAuthFailure): FastifyReply {
  return reply.code(failure.status).send({ error: failure.error, error_description: failure.error_description });
}
