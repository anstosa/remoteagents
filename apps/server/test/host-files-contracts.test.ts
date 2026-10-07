import { describe, expect, it } from 'vitest';
import { isHostFilesCommand, isHostFilesReadCommand, isHostFilesWriteCommand, type HostFileIdentity } from '../src/host-files/contracts.js';
import { HostFilesTokenService } from '../src/host-files/tokens.js';

const identity: HostFileIdentity = { dev: '1', ino: '2', ctimeNs: '3', mtimeNs: '4', size: '5', nlink: '1', kind: 'file' };

describe('host Files contracts and tokens', () => {
  // accept the complete identity-bound command envelope
  it('validates commands and rejects raw or incomplete paths', () => {
    const manifest = { root: '/source', totalBytes: 5, entries: [{ path: '/source', identity }] };
    expect(isHostFilesCommand({ kind: 'copy', operationId: 'operation_123456789', sourcePath: '/source', sourceIdentity: identity, sourceManifest: manifest, destinationPath: '/target', destinationParentIdentity: { ...identity, kind: 'directory' }, replace: false })).toBe(true);
    expect(isHostFilesCommand({ kind: 'copy', operationId: 'operation_123456789', sourcePath: '../source', sourceIdentity: identity, sourceManifest: manifest, destinationPath: '/target', replace: false })).toBe(false);
    expect(isHostFilesCommand({ kind: 'remove', operationId: 'operation_123456789', items: [{ path: '/source', identity }] })).toBe(false);
    expect(isHostFilesCommand({ kind: 'favorites-add', placeId: 'project:/one', path: '/source', identity })).toBe(true);
    expect(isHostFilesCommand({ kind: 'favorites-list', placeId: '__proto__' })).toBe(false);
    expect(isHostFilesCommand({ kind: 'favorites-rewrite', rewrites: [{ placeId: 'project:/one', favoriteId: 'favorite_123456789', path: '/target', identity }] })).toBe(true);
    expect(isHostFilesCommand({ kind: 'favorites-rewrite', rewrites: [{ placeId: 'project:/one', favoriteId: 'short', path: '/target', identity }] })).toBe(false);
    expect(isHostFilesReadCommand({ kind: 'read', path: '/source', identity, start: 0, length: 5 })).toBe(true);
    expect(isHostFilesWriteCommand({ kind: 'write', operationId: 'operation_123456789', path: '/target', size: 5, destinationParentIdentity: { ...identity, kind: 'directory' }, replace: false })).toBe(true);
  });

  // bind opaque capabilities to purpose, session, Place, generation and expiry
  it('rejects tampering, replay context and backend rotation', () => {
    let now = 1_000;
    let generation = 'generation-a';
    const tokens = new HostFilesTokenService('contract-test-secret-at-least-sixteen', () => generation, () => now, 100);
    const token = tokens.issue({ purpose: 'object', sessionId: 'session-a', placeId: 'place-a', path: '/source', identity });
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-a', placeId: 'place-a' })).toMatchObject({ path: '/source', identity });
    expect(tokens.verify(token, { purpose: 'destination-directory', sessionId: 'session-a', placeId: 'place-a' })).toBeUndefined();
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-b', placeId: 'place-a' })).toBeUndefined();
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-a', placeId: 'place-b' })).toBeUndefined();
    const [body, signature] = token.split('.') as [string, string];
    const tampered = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(tokens.verify(tampered, { purpose: 'object', sessionId: 'session-a', placeId: 'place-a' })).toBeUndefined();
    // allow source verification to retain its signed original Place
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-a' })?.placeId).toBe('place-a');
    generation = 'generation-b';
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-a', placeId: 'place-a' })).toBeUndefined();
    generation = 'generation-a'; now = 1_101;
    expect(tokens.verify(token, { purpose: 'object', sessionId: 'session-a', placeId: 'place-a' })).toBeUndefined();
  });
});
