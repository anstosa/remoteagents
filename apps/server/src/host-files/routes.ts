import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { TicketStore } from '../auth/tickets.js';
import type { Session } from '../auth/service.js';
import type { Place } from '../places/places.js';
import { HostFilesError, type CollisionDecision } from './contracts.js';
import { HostFilesTransportError } from './protocol.js';
import { HostFilesService, type PrepareOperationInput, type PrepareUploadInput } from './service.js';

type RouteDependencies = {
  service: HostFilesService;
  controlled: (request: FastifyRequest, mutation?: boolean) => Session;
  resolvePlace: (id: string) => Promise<Place | undefined>;
  downloadTickets: Pick<TicketStore, 'mint'|'consume'>;
};
type PlaceRequest = FastifyRequest<{ Params: { placeId: string } }>;

// read one plain JSON body without accepting arrays or primitives
function jsonBody(request: FastifyRequest): Record<string, unknown> {
  // require one JSON object
  if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) throw new HostFilesError('invalid_request', 'invalid request body', 400);
  return request.body as Record<string, unknown>;
}

// require exactly the permitted request keys
function exactKeys(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  // reject missing or injected fields
  if (required.some(key => !(key in body)) || Object.keys(body).some(key => !allowed.has(key))) throw new HostFilesError('invalid_request', 'invalid request body', 400);
}

// validate one conflict-decision map
function decisions(value: unknown): Record<string, CollisionDecision> {
  // require one plain map
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HostFilesError('invalid_request', 'invalid collision decisions', 400);
  const result: Record<string, CollisionDecision> = {};
  // validate every decision id and choice
  for (const [id, decision] of Object.entries(value)) {
    // reject unsafe ids and choices
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(id) || !['replace', 'skip', 'keep-both'].includes(decision as string)) throw new HostFilesError('invalid_request', 'invalid collision decisions', 400);
    result[id] = decision as CollisionDecision;
  }
  return result;
}

// resolve one current Place without trusting browser path metadata
async function placeOf(deps: RouteDependencies, request: PlaceRequest): Promise<Place> {
  const place = await deps.resolvePlace(request.params.placeId);
  // hide unknown Place ids
  if (place === undefined) throw new HostFilesError('not_found', 'Place not found', 404);
  return place;
}

// map stable Files errors into one consistent HTTP body
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const plain = error as { statusCode?: number; message?: string };
  const failure = error instanceof HostFilesError ? error : error instanceof HostFilesTransportError
    ? { code: error.code === 'broker_busy' ? 'broker_busy' : 'bridge_unavailable', message: error.code === 'broker_busy' ? 'host files broker is busy' : 'host files bridge is unavailable', statusCode: 503, retryable: error.code === 'broker_busy' }
    : typeof plain.statusCode === 'number' && [401, 403, 423].includes(plain.statusCode)
    ? { code: plain.statusCode === 401 ? 'unauthorized' : plain.statusCode === 403 ? 'forbidden' : 'inactive_client', message: plain.message ?? 'request denied', statusCode: plain.statusCode, retryable: false }
    : new HostFilesError('partial_failure', 'file operation failed', 500);
  // publish retry guidance only for bounded saturation states
  if (failure.code === 'busy' || failure.code === 'broker_busy') reply.header('Retry-After', '1');
  return reply.code(failure.statusCode).send({ error: { code: failure.code, message: failure.message, ...(failure.retryable ? { retryable: true, retryAfterMs: 1000 } : {}) } });
}

// wrap one route with stable Files-only error mapping
function endpoint<T extends FastifyRequest>(handler: (request: T, reply: FastifyReply) => Promise<unknown>) {
  return async (request: T, reply: FastifyReply) => {
    try { return await handler(request, reply); }
    catch (error) { return sendError(reply, error); }
  };
}

// create a safe attachment header with ASCII and RFC 5987 names
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\\r\n]/gu, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// parse one discriminated operation-prepare body
function operationInput(request: FastifyRequest): PrepareOperationInput {
  const body = jsonBody(request);
  const kind = body.kind;
  // parse create requests
  if (kind === 'create-file' || kind === 'create-folder') {
    exactKeys(body, ['kind', 'name', 'destinationDirectoryToken']);
    // require string leaves and capabilities
    if (typeof body.name !== 'string' || typeof body.destinationDirectoryToken !== 'string') throw new HostFilesError('invalid_request', 'invalid request body', 400);
    return { kind, name: body.name, destinationDirectoryToken: body.destinationDirectoryToken };
  }
  // parse rename requests
  if (kind === 'rename') {
    exactKeys(body, ['kind', 'sourceToken', 'newName', 'destinationDirectoryToken']);
    // require string leaves and capabilities
    if (typeof body.sourceToken !== 'string' || typeof body.newName !== 'string' || typeof body.destinationDirectoryToken !== 'string') throw new HostFilesError('invalid_request', 'invalid request body', 400);
    return { kind, sourceToken: body.sourceToken, newName: body.newName, destinationDirectoryToken: body.destinationDirectoryToken };
  }
  // parse copy and move requests
  if (kind === 'copy' || kind === 'move') {
    exactKeys(body, ['kind', 'sourceTokens', 'destinationDirectoryToken']);
    // require one string-token array
    if (!Array.isArray(body.sourceTokens) || !body.sourceTokens.every(token => typeof token === 'string') || typeof body.destinationDirectoryToken !== 'string') throw new HostFilesError('invalid_request', 'invalid request body', 400);
    return { kind, sourceTokens: body.sourceTokens, destinationDirectoryToken: body.destinationDirectoryToken };
  }
  // parse delete requests
  if (kind === 'delete') {
    exactKeys(body, ['kind', 'sourceTokens']);
    // require one string-token array
    if (!Array.isArray(body.sourceTokens) || !body.sourceTokens.every(token => typeof token === 'string')) throw new HostFilesError('invalid_request', 'invalid request body', 400);
    return { kind, sourceTokens: body.sourceTokens };
  }
  throw new HostFilesError('invalid_request', 'unknown file operation kind', 400);
}

// register the complete authenticated Place-scoped Files route family
export async function registerHostFilesRoutes(app: FastifyInstance, deps: RouteDependencies): Promise<void> {
  app.post('/api/worktrees/:placeId/files/list', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, [], ['path', 'objectToken']);
    // require an optional absolute path string
    if (body.path !== undefined && typeof body.path !== 'string') throw new HostFilesError('invalid_request', 'invalid path', 400);
    // require one optional exact row capability for folder-scoped actions
    if (body.objectToken !== undefined && typeof body.objectToken !== 'string') throw new HostFilesError('invalid_request', 'invalid object token', 400);
    return await deps.service.list(place, session, body.path, body.objectToken);
  }));

  app.post('/api/worktrees/:placeId/files/preview', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['objectToken']);
    // require one opaque object token
    if (typeof body.objectToken !== 'string') throw new HostFilesError('invalid_request', 'invalid object token', 400);
    return await deps.service.preview(place, session, body.objectToken);
  }));

  app.get('/api/worktrees/:placeId/file-favorites', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request);
    return await deps.service.listFavorites(await placeOf(deps, request), session);
  }));

  app.put('/api/worktrees/:placeId/file-favorites', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['objectToken']);
    // require one opaque object token
    if (typeof body.objectToken !== 'string') throw new HostFilesError('invalid_request', 'invalid object token', 400);
    return await deps.service.addFavorite(place, session, body.objectToken);
  }));

  app.post('/api/worktrees/:placeId/file-favorites/:favoriteId/acknowledge', endpoint<FastifyRequest<{ Params: { placeId: string; favoriteId: string } }>>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['objectToken']);
    // require one opaque object token
    if (typeof body.objectToken !== 'string') throw new HostFilesError('invalid_request', 'invalid object token', 400);
    return await deps.service.acknowledgeFavorite(place, session, request.params.favoriteId, body.objectToken);
  }));

  app.delete('/api/worktrees/:placeId/file-favorites/:favoriteId', endpoint<FastifyRequest<{ Params: { placeId: string; favoriteId: string } }>>(async (request, reply) => {
    deps.controlled(request, true);
    await deps.service.removeFavorite(await placeOf(deps, request), request.params.favoriteId);
    return reply.code(204).send();
  }));

  app.post('/api/worktrees/:placeId/files/operations/prepare', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    return await deps.service.prepareOperation(await placeOf(deps, request), session, operationInput(request));
  }));

  app.post('/api/worktrees/:placeId/files/operations/:operationId/execute', endpoint<FastifyRequest<{ Params: { placeId: string; operationId: string } }>>(async (request, reply) => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['decisions'], ['confirmed']);
    // require an optional boolean confirmation
    if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') throw new HostFilesError('invalid_request', 'invalid confirmation', 400);
    const operation = await deps.service.executeOperation(place, session, request.params.operationId, decisions(body.decisions), body.confirmed === true);
    return reply.code(202).send(operation);
  }));

  app.get('/api/worktrees/:placeId/files/operations/:operationId', endpoint<FastifyRequest<{ Params: { placeId: string; operationId: string } }>>(async request => {
    const session = deps.controlled(request);
    return { operation: deps.service.operation(await placeOf(deps, request), session, request.params.operationId) };
  }));

  app.post('/api/worktrees/:placeId/files/uploads/prepare', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['destinationDirectoryToken', 'files']);
    // validate the shallow upload declaration before service limits
    if (typeof body.destinationDirectoryToken !== 'string' || !Array.isArray(body.files) || !body.files.every(file => file !== null && typeof file === 'object' && !Array.isArray(file))) throw new HostFilesError('invalid_request', 'invalid upload declaration', 400);
    const files = body.files.map(file => {
      const value = file as Record<string, unknown>;
      exactKeys(value, ['clientId', 'name', 'size']);
      // require exact declaration fields
      if (typeof value.clientId !== 'string' || typeof value.name !== 'string' || typeof value.size !== 'number') throw new HostFilesError('invalid_request', 'invalid upload declaration', 400);
      return { clientId: value.clientId, name: value.name, size: value.size };
    });
    return await deps.service.prepareUpload(place, session, { destinationDirectoryToken: body.destinationDirectoryToken, files } satisfies PrepareUploadInput);
  }));

  app.post('/api/worktrees/:placeId/files/uploads/:uploadId/authorize', endpoint<FastifyRequest<{ Params: { placeId: string; uploadId: string } }>>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['decisions']);
    return await deps.service.authorizeUpload(place, session, request.params.uploadId, decisions(body.decisions));
  }));

  // encapsulate the raw parser so unrelated routes retain their existing content-type policy
  await app.register(async uploadRoutes => {
    // normalize authentication failures raised before the upload handler
    uploadRoutes.setErrorHandler((error, _request, reply) => sendError(reply, error));
    uploadRoutes.addContentTypeParser('application/octet-stream', (_request, payload, done) => { done(null, payload); });
    uploadRoutes.put('/api/worktrees/:placeId/files/uploads/:uploadId/:clientId', {
      bodyLimit: 1024 * 1024 * 1024,
      // authenticate before Fastify exposes any application bytes
      onRequest: async request => { deps.controlled(request, true); },
      handler: endpoint<FastifyRequest<{ Params: { placeId: string; uploadId: string; clientId: string } }>>(async request => {
        const session = deps.controlled(request, true);
        const place = await placeOf(deps, request);
        const token = request.headers['x-files-upload-token'];
        // require one header capability and raw stream body
        if (typeof token !== 'string' || !(request.body instanceof Readable)) throw new HostFilesError('invalid_request', 'invalid upload body', 400);
        return await deps.service.upload(place, session, request.params.uploadId, request.params.clientId, token, request.body);
      }),
    });
  });

  app.post('/api/worktrees/:placeId/files/downloads', endpoint<PlaceRequest>(async request => {
    const session = deps.controlled(request, true);
    const place = await placeOf(deps, request);
    const body = jsonBody(request);
    exactKeys(body, ['objectTokens']);
    // require one string-token array
    if (!Array.isArray(body.objectTokens) || !body.objectTokens.every(token => typeof token === 'string')) throw new HostFilesError('invalid_request', 'invalid download selection', 400);
    const prepared = await deps.service.prepareDownload(place, session, body.objectTokens);
    const ticket = deps.downloadTickets.mint(session.id, 'files-download', prepared.target);
    return { downloadId: prepared.downloadId, filename: prepared.filename, url: `/api/files/downloads/${prepared.downloadId}?ticket=${encodeURIComponent(ticket.id)}` };
  }));

  app.get('/api/files/downloads/:downloadId', endpoint<FastifyRequest<{ Params: { downloadId: string }; Querystring: { ticket?: string } }>>(async (request, reply) => {
    const session = deps.controlled(request);
    const ticket = request.query.ticket;
    // consume the one-use session and manifest-bound ticket
    if (typeof ticket !== 'string' || !deps.downloadTickets.consume(ticket, session.id, 'files-download', request.params.downloadId)) throw new HostFilesError('not_found', 'download unavailable', 404);
    const download = await deps.service.openDownload(session, request.params.downloadId);
    reply.header('Content-Type', download.contentType);
    reply.header('Content-Disposition', contentDisposition(download.filename));
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(download.stream);
  }));

  app.get('/api/worktrees/:placeId/files/downloads/:downloadId/status', endpoint<FastifyRequest<{ Params: { placeId: string; downloadId: string } }>>(async request => {
    const session = deps.controlled(request);
    return deps.service.downloadStatus(await placeOf(deps, request), session, request.params.downloadId);
  }));
}
