import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

const bookmark = { id: 'bookmark-identifier-001', threadId: '0198c333-3333-7333-8333-333333333333', title: 'Shared Potato chat', createdAt: '2026-08-20T20:00:00.000Z' };
// a configured codex Adapter lets any of a Project's worktrees resume through the Adapter
const codexConfig = () => testConfig({ adapters: { codex: { program: '/usr/bin/codex', args: [], env: {}, launchable: true } } });
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

// authenticate one test browser
async function authenticatedHeaders(app: Awaited<ReturnType<typeof buildApp>>) {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
}

describe('chat bookmark API', () => {
  it('shares a Project bookmark key across its worktrees for lists, current-chat bookmarks, renames, and deletes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // two Linked worktrees of one Project share the Project bookmark key `potato`
    const worktree = testWorktree({ id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora' });
    const otherWorktree = testWorktree({ id: 'owen', projectId: 'potato', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', hostPath: '/home/ubuntu/owen', main: false });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', projectId: 'potato', worktreeId: 'cora', title: 'Ready' });
    const otherAgent = { ...agent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', workspace: '/home/ubuntu/owen', worktreeId: 'owen' };
    const calls: string[] = [];
    const renamedBookmark = { ...bookmark, title: 'Release readiness chat' };
    const bookmarks = {
      list: async (key: string) => { calls.push(`list:${key}`); return [bookmark]; },
      create: async (key: string, value: { threadId: string; kind?: string }) => { calls.push(`create:${key}:${value.threadId}:${value.kind}`); return bookmark; },
      rename: async (key: string, id: string, title: string) => { calls.push(`rename:${key}:${id}:${title}`); return renamedBookmark; },
      remove: async (key: string, id: string) => { calls.push(`remove:${key}:${id}`); return bookmark; },
      get: async () => bookmark
    };
    const discovery = {
      // resolve both shared-group agent fixtures
      target: async (id: string) => {
        const selected = [agent, otherAgent].find(candidate => candidate.id === id);
        return selected === undefined ? undefined : { agent: selected, socket };
      },
      // expose one selected conversation, reported and with a title
      conversationId: async () => bookmark.threadId,
      conversation: async () => ({ id: bookmark.threadId, title: bookmark.title }),
      worktreesNow: () => [worktree, otherWorktree],
      // expose both dashboard agents
      dashboard: async () => ({ generation: 1, adapters: {}, agents: [agent, otherAgent], projects: [] })
    };
    const app = await buildApp(codexConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never, bookmarks: bookmarks as never });
    try {
      const headers = await authenticatedHeaders(app);

      const listed = await app.inject({ method: 'GET', url: '/api/worktrees/cora/bookmarks?agentId=agent-1', headers: { host: headers.host, cookie: headers.cookie } });
      const mismatched = await app.inject({ method: 'GET', url: '/api/worktrees/cora/bookmarks?agentId=agent-2', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await app.inject({ method: 'POST', url: '/api/agents/agent-1/bookmarks', headers });
      const renamed = await app.inject({ method: 'PATCH', url: `/api/worktrees/cora/bookmarks/${bookmark.id}`, headers, payload: { title: renamedBookmark.title } });
      const removed = await app.inject({ method: 'DELETE', url: `/api/worktrees/cora/bookmarks/${bookmark.id}`, headers });

      // any launchable codex worktree can resume through its Adapter, without a resumeCommand template
      expect(listed.json()).toEqual({ bookmarks: [bookmark], canResume: true, currentBookmarkId: bookmark.id });
      expect(mismatched.json()).toEqual({ bookmarks: [bookmark], canResume: true });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual(bookmark);
      expect(renamed.json()).toEqual(renamedBookmark);
      expect(removed.json()).toEqual(bookmark);
      // every operation keys by the Project id, shared across its worktrees
      expect(calls.filter(call => call === 'list:potato')).toHaveLength(2);
      expect(calls).toEqual(expect.arrayContaining([
        'create:potato:0198c333-3333-7333-8333-333333333333:codex',
        `rename:potato:${bookmark.id}:${renamedBookmark.title}`,
        `remove:potato:${bookmark.id}`
      ]));
    } finally {
      await app.close();
    }
  }, 15_000);

  it('keeps scratch bookmarks in one stable workspace group', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const firstAgent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu', title: 'Scratch' });
    const secondAgent = { ...firstAgent, id: 'scratch-2', paneId: '%2', sessionId: 'socket:$2' };
    const renamedBookmark = { ...bookmark, title: 'Scratch release plan' };
    const calls: string[] = [];
    const bookmarks = {
      list: async (key: string) => { calls.push(`list:${key}`); return [bookmark]; },
      create: async (key: string) => { calls.push(`create:${key}`); return bookmark; },
      rename: async (key: string, id: string) => { calls.push(`rename:${key}:${id}`); return renamedBookmark; },
      remove: async (key: string, id: string) => { calls.push(`remove:${key}:${id}`); return bookmark; }
    };
    const discovery = {
      // resolve either scratch agent in the shared workspace
      target: async (id: string) => {
        const agent = [firstAgent, secondAgent].find(candidate => candidate.id === id);
        return agent === undefined ? undefined : { agent, socket };
      },
      // expose one selected conversation
      conversationId: async () => bookmark.threadId,
      conversation: async () => ({ id: bookmark.threadId, title: bookmark.title }),
      worktreesNow: () => [],
      dashboard: async () => ({ generation: 1, adapters: {}, agents: [firstAgent, secondAgent], projects: [] })
    };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 25).toString('base64url')), discovery: discovery as never, bookmarks: bookmarks as never });
    try {
      const headers = await authenticatedHeaders(app);

      const firstList = await app.inject({ method: 'GET', url: `/api/agents/${firstAgent.id}/bookmarks`, headers: { host: headers.host, cookie: headers.cookie } });
      const secondList = await app.inject({ method: 'GET', url: `/api/agents/${secondAgent.id}/bookmarks`, headers: { host: headers.host, cookie: headers.cookie } });
      const created = await app.inject({ method: 'POST', url: `/api/agents/${firstAgent.id}/bookmarks`, headers });
      const renamed = await app.inject({ method: 'PATCH', url: `/api/agents/${firstAgent.id}/bookmarks/${bookmark.id}`, headers, payload: { title: renamedBookmark.title } });
      const removed = await app.inject({ method: 'DELETE', url: `/api/agents/${secondAgent.id}/bookmarks/${bookmark.id}`, headers });

      expect(firstList.json()).toEqual({ bookmarks: [bookmark], canResume: false, currentBookmarkId: bookmark.id });
      expect(secondList.json()).toEqual(firstList.json());
      expect(created.statusCode).toBe(201);
      expect(renamed.json()).toEqual(renamedBookmark);
      expect(removed.json()).toEqual(bookmark);
      const keys = calls.map(call => call.split(':')[1]);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/^scratch_[A-Za-z0-9_-]{40}$/u);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('keys a non-git directory Project agent under the Scratch key, so notes and bookmarks still work', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // a `directory` Project has no worktrees, so its agent never resolves to one: notes and
    // bookmarks fall through to the Scratch key for its directory, exactly like Scratch
    const config = testConfig({ projects: [testProject({ id: 'notes', label: 'Notes', path: '/home/me/notes', identity: '/home/me/notes', mode: 'directory', available: true })] });
    const agent = stated({ id: 'agent-dir', paneId: '%9', sessionId: 'socket:$9', socketFingerprint: 'socket', workspace: '/home/me/notes', title: 'Ready' });
    const noteCalls: string[] = [];
    const bookmarkCalls: string[] = [];
    const notes = { create: async (key: string) => { noteCalls.push(key); return { id: 'note-1' }; } };
    const bookmarks = { create: async (key: string, value: { threadId: string }) => { bookmarkCalls.push(key); return { ...bookmark, threadId: value.threadId }; } };
    const discovery = {
      target: async (id: string) => id === agent.id ? { agent, socket } : undefined,
      conversation: async () => ({ id: bookmark.threadId, title: bookmark.title }),
      // no worktree matches the directory workspace, so persistence resolves to the Scratch key
      worktreesNow: () => [],
      dashboard: async () => ({ generation: 1, adapters: {}, agents: [agent], projects: [] })
    };
    const app = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 24).toString('base64url')), discovery: discovery as never, notes: notes as never, bookmarks: bookmarks as never });
    try {
      const headers = await authenticatedHeaders(app);
      const note = await app.inject({ method: 'POST', url: '/api/agents/agent-dir/notes', headers });
      const created = await app.inject({ method: 'POST', url: '/api/agents/agent-dir/bookmarks', headers });
      expect(note.statusCode).toBe(201);
      expect(created.statusCode).toBe(201);
      // both persist under the Scratch key derived from the directory path, never a projectId
      const scratchKey = `scratch_${createHash('sha256').update('/home/me/notes').digest('base64url').slice(0, 40)}`;
      expect(noteCalls).toEqual([scratchKey]);
      expect(bookmarkCalls).toEqual([scratchKey]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('launches an inactive worktree into the selected bookmarked chat', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora' });
    const replacement = stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', projectId: 'potato', worktreeId: 'cora', title: 'Ready' });
    let launched = false;
    const discovery = { target: async () => undefined, worktreesNow: () => [worktree], dashboard: async () => ({ generation: launched ? 2 : 1, adapters: {}, agents: launched ? [replacement] : [], projects: [] }) };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, threadId: string) => { launched = worktreeId === 'cora' && threadId === bookmark.threadId; return launched; } };
    const bookmarks = { get: async (key: string, id: string) => key === 'potato' && id === bookmark.id ? bookmark : undefined };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: bookmarks as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);

      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/cora/bookmarks/${bookmark.id}/switch`, headers });

      expect(switched.statusCode).toBe(201);
      expect(switched.json()).toEqual({ agentId: replacement.id });
      expect(launched).toBe(true);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('closes an idle agent before resuming the selected bookmarked chat', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora' });
    const firstAgent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', projectId: 'potato', worktreeId: 'cora', title: 'Ready' });
    const replacement = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const events: string[] = [];
    let resumed = false;
    const discovery = {
      // expose the replacement after resume
      dashboard: async () => ({ generation: resumed ? 2 : 1, adapters: {}, agents: [resumed ? replacement : firstAgent], projects: [] }),
      worktreesNow: () => [worktree],
      // resolve the original target
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, threadId: string) => { events.push(`resume:${worktreeId}:${threadId}`); resumed = true; return true; } };
    const bookmarks = { get: async () => bookmark };
    const queuedPrompts = { list: async () => [] };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: bookmarks as never, queuedPrompts: queuedPrompts as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);

      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/cora/bookmarks/${bookmark.id}/switch`, headers });

      expect(switched.statusCode).toBe(201);
      expect(switched.json()).toEqual({ agentId: replacement.id });
      expect(events).toEqual([`close:${firstAgent.id}`, `resume:cora:${bookmark.threadId}`]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('preserves an open agent when exact resume is not configured', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora' });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', projectId: 'potato', worktreeId: 'cora', title: 'Ready' });
    let closed = false;
    const discovery = { dashboard: async () => ({ generation: 1, adapters: {}, agents: [agent], projects: [] }), worktreesNow: () => [worktree], target: async () => ({ agent, socket }) };
    const launch = { canResumeConversation: () => false, resumeConversation: async () => false };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 24).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: { get: async () => bookmark } as never, queuedPrompts: { list: async () => [] } as never, tmux: { close: async () => { closed = true; return true; } } as never });
    try {
      const headers = await authenticatedHeaders(app);

      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/cora/bookmarks/${bookmark.id}/switch`, headers });

      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'Exact chat resume is not configured for this worktree.' });
      expect(closed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('rejects a bookmark whose thread id its Adapter will not resume', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = testWorktree({ id: 'cora', projectId: 'potato', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora' });
    let resumed = false;
    // a persisted bookmark whose thread id is not a valid Codex conversation id
    const invalid = { ...bookmark, threadId: 'not-a-session' };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, adapters: {}, agents: [], projects: [] }) };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 26).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: { get: async () => invalid } as never });
    try {
      const headers = await authenticatedHeaders(app);

      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/cora/bookmarks/${bookmark.id}/switch`, headers });

      // the Adapter's validId gate fails closed before any resume
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'This bookmark cannot be resumed.' });
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);
});
