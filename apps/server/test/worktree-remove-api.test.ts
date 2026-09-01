import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { SavedPromptService } from '../src/saved-prompts/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { stated } from './helpers/agent.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutationHeaders = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const readHeaders = { host, cookie: '__Host-rac=x' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const linked = testWorktree({ id: 'proj:/repo/wts/feat', projectId: 'proj', label: 'Proj · feat', path: '/repo/wts/feat', identity: '/repo/wts/feat', main: false, pinned: false, branch: 'feat' });
const cleanFacts = { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 0, pushed: true, merged: true, ahead: 0, behind: 0 };

async function stores() {
  const root = await mkdtemp(join(tmpdir(), 'rac-remove-api-')); dirs.push(root);
  return {
    worktreeStore: new WorktreeLaunchStore({ file: join(root, 'worktrees.json') }),
    queuedPrompts: new QueuedPromptService(join(root, 'queued.json')),
    promptHistory: new PromptHistoryService(join(root, 'history.json')),
    savedPrompts: new SavedPromptService(join(root, 'saved.json')),
    reviewStore: new ReviewTourStore(join(root, 'reviews.json'))
  };
}

// a discovery stub reporting the linked worktree, with a controllable running-agent set
function discoveryStub(agents: Array<{ worktreeId?: string }> = [], worktrees = [linked]) {
  return {
    invalidateWorktrees: () => {},
    worktreesNow: () => worktrees,
    worktrees: async () => worktrees,
    dashboard: async () => ({ generation: 1, adapters: {}, agents, projects: [] })
  } as never;
}

async function app(deps: Record<string, unknown>) {
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects: [testProject({ id: 'proj' })] }), { auth, control, dashboardUpdates, ...deps } as never);
}

describe('GET /api/worktrees/:id/removal', () => {
  it('returns the fresh facts and the runtime blockers', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }) } as never;
    const agent = stated({ id: 'agent-x', paneId: '%1', sessionId: 's:$1', socketFingerprint: 's', workspace: linked.identity, worktreeId: linked.id, title: 'Ready' });
    const server = await app({ discovery: discoveryStub([agent]), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...cleanFacts, blockers: ['a running agent'] });
    } finally { await server.close(); }
  });

  it('404s an unknown worktree and propagates a service refusal', async () => {
    const worktreeManagement = { removal: async () => ({ ok: false, status: 409, error: 'blocked' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/proj%3A%2Fnope/removal', headers: readHeaders })).statusCode).toBe(404);
      const refused = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'blocked' });
    } finally { await server.close(); }
  });
});

describe('DELETE /api/worktrees/:id', () => {
  it('refuses main, locked, a running agent, and a dirty tree without discard — with no side effects', async () => {
    const killed: string[] = [];
    let removeCalls = 0;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, dirtyCount: 3 } }), removeCheckout: async () => { removeCalls += 1; return { ok: true }; } } as never;
    const launch = { killWorktreeShells: async (w: { id: string }) => { killed.push(w.id); } } as never;
    const main = testWorktree({ id: 'proj:/repo', projectId: 'proj', path: '/repo', identity: '/repo', main: true });
    const locked = testWorktree({ ...linked, locked: true });
    const withMain = await app({ discovery: discoveryStub([], [main]), worktreeManagement, launch, ...(await stores()) });
    try {
      expect((await withMain.inject({ method: 'DELETE', url: '/api/worktrees/proj%3A%2Frepo', headers: mutationHeaders })).statusCode).toBe(409);
    } finally { await withMain.close(); }
    const withLocked = await app({ discovery: discoveryStub([], [locked]), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await withLocked.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Locked worktrees cannot be removed' });
    } finally { await withLocked.close(); }
    const agent = stated({ id: 'agent-x', paneId: '%1', sessionId: 's:$1', socketFingerprint: 's', workspace: linked.identity, worktreeId: linked.id, title: 'Ready' });
    const withAgent = await app({ discovery: discoveryStub([agent]), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await withAgent.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('a running agent');
    } finally { await withAgent.close(); }
    // a dirty tree without discard is refused, and its records survive untouched
    const dirtyStores = await stores();
    await dirtyStores.worktreeStore.setPinned(linked.id, true);
    const dirty = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...dirtyStores });
    try {
      const response = await dirty.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('Discard uncommitted changes');
      expect(await dirtyStores.worktreeStore.pins()).toEqual({ [linked.id]: true });
    } finally { await dirty.close(); }
    // no refusal ever killed a shell or ran git remove
    expect(killed).toEqual([]);
    expect(removeCalls).toBe(0);
  });

  it('refuses removal while a running stack command holds the worktree', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => ({ ok: true }) } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    // no running agent, but the stack service reports an active operation
    const worktreeCommands = { sessionRunning: async () => true } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('a running stack command');
    } finally { await server.close(); }
  });

  it('kills the idle shells before git, deletes every wire-id record after, and returns removed', async () => {
    const order: string[] = [];
    const invalidated: string[] = [];
    // killWorktreeShells resolves on a later tick; if the route dropped its `await`,
    // removeCheckout would push 'remove' first — so this proves completion order, not call order
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { order.push('remove'); return { ok: true }; } } as never;
    const launch = { killWorktreeShells: async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('kill'); } } as never;
    const { worktreeStore, queuedPrompts, promptHistory, savedPrompts } = await stores();
    const reviewStore = { summaries: async () => [], current: async () => undefined, invalidate: async (id: string) => { invalidated.push(id); return 1; }, save: async () => undefined } as never;
    await worktreeStore.setPinned(linked.id, true);
    await queuedPrompts.enqueue(linked.id, 'hello');
    await promptHistory.record(linked.id, 'hello');
    await savedPrompts.save(linked.id, 'a reusable prompt');
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore, queuedPrompts, promptHistory, savedPrompts, reviewStore });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      // the idle shell is killed before git removes the checkout
      expect(order).toEqual(['kill', 'remove']);
      // every wire-id-keyed record for the worktree is gone; the review tour is invalidated
      expect(await worktreeStore.pins()).toEqual({});
      expect(await queuedPrompts.list(linked.id)).toEqual([]);
      expect(await promptHistory.list(linked.id)).toEqual([]);
      expect(await savedPrompts.list(linked.id)).toEqual([]);
      expect(invalidated).toEqual([linked.id]);
    } finally { await server.close(); }
  });

  it('removes a clean tree without --force', async () => {
    let forced: boolean | undefined;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async (_w: unknown, o: { force: boolean }) => { forced = o.force; return { ok: true }; } } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(200);
      // a clean removal never forces
      expect(forced).toBe(false);
    } finally { await server.close(); }
  });

  it('force-removes a dirty tree when discardChanges is set', async () => {
    let forced: boolean | undefined;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, dirtyCount: 2 } }), removeCheckout: async (_w: unknown, o: { force: boolean }) => { forced = o.force; return { ok: true }; } } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { discardChanges: true } });
      expect(response.statusCode).toBe(200);
      expect(forced).toBe(true);
    } finally { await server.close(); }
  });

  it('preserves the worktree records when git removal fails', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => ({ ok: false, status: 409, error: 'fatal: could not remove' }) } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    const { worktreeStore, queuedPrompts, promptHistory, savedPrompts, reviewStore } = await stores();
    await worktreeStore.setPinned(linked.id, true);
    await queuedPrompts.enqueue(linked.id, 'keep me');
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore, queuedPrompts, promptHistory, savedPrompts, reviewStore });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'fatal: could not remove' });
      // records are deleted only after a successful removal
      expect(await worktreeStore.pins()).toEqual({ [linked.id]: true });
      expect(await queuedPrompts.list(linked.id)).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('deletes the branch only when pushed or merged, reporting its failure without undoing', async () => {
    const deleted: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => ({ ok: true }), deleteBranch: async (_w: unknown, b: string) => { deleted.push(b); return { ok: false, error: 'error: unmerged' }; } } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { deleteBranch: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true, branchDeleteError: 'error: unmerged' });
      expect(deleted).toEqual(['feat']);
    } finally { await server.close(); }
  });

  it('never deletes an ineligible branch even when requested', async () => {
    const deleted: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, pushed: false, merged: false } }), removeCheckout: async () => ({ ok: true }), deleteBranch: async (_w: unknown, b: string) => { deleted.push(b); return { ok: true }; } } as never;
    const launch = { killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { deleteBranch: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      expect(deleted).toEqual([]);
    } finally { await server.close(); }
  });
});

describe('POST /api/projects/:id/worktrees/prune', () => {
  it('prunes, deletes orphaned records, and returns 204', async () => {
    const worktreeManagement = { prune: async () => ({ ok: true }) } as never;
    const { worktreeStore, queuedPrompts, promptHistory } = await stores();
    // one record git still lists (kept) and one it lists nowhere (orphan, deleted)
    await worktreeStore.setPinned(linked.id, true);
    await worktreeStore.setPinned('proj:/repo/wts/gone', true);
    await queuedPrompts.enqueue('proj:/repo/wts/gone', 'stale');
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeStore, queuedPrompts, promptHistory });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees/prune', headers: mutationHeaders });
      expect(response.statusCode).toBe(204);
      expect(await worktreeStore.pins()).toEqual({ [linked.id]: true });
      expect(await queuedPrompts.list('proj:/repo/wts/gone')).toEqual([]);
    } finally { await server.close(); }
  });

  it('propagates a service refusal', async () => {
    const worktreeManagement = { prune: async () => ({ ok: false, status: 409, error: 'blocked' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees/prune', headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'blocked' });
    } finally { await server.close(); }
  });
});
