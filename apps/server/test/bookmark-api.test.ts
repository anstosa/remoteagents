import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';

const bookmark = { id: 'bookmark-identifier-001', threadId: '0198c333-3333-7333-8333-333333333333', title: 'Shared Potato chat', createdAt: '2026-08-20T20:00:00.000Z' };

// authenticate one test browser
async function authenticatedHeaders(app: Awaited<ReturnType<typeof buildApp>>) {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
}

describe('chat bookmark API', () => {
  it('uses a worktree save key for lists, current-chat bookmarks, renames, and deletes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', saveKey: 'potato', available: true, pinned: true, command: 'codex' };
    const otherWorktree = { ...worktree, id: 'owen', label: 'Owen', path: '/worktrees/owen', identity: '/worktrees/owen', hostPath: '/home/ubuntu/owen' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', worktreeId: 'cora', title: 'Ready' });
    const otherAgent = { ...agent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', workspace: '/home/ubuntu/owen', worktreeId: 'owen' };
    const calls: string[] = [];
    const renamedBookmark = { ...bookmark, title: 'Release readiness chat' };
    const bookmarks = {
      list: async (key: string) => { calls.push(`list:${key}`); return [bookmark]; },
      // resolve the selected fixture thread
      currentThreadId: async (sessions: Array<{ id: string }>) => { calls.push(`current:${sessions.map(session => session.id).join(',')}`); return bookmark.threadId; },
      bookmarkCurrent: async (key: string, sessions: Array<{ id: string }>) => { calls.push(`create:${key}:${sessions.map(session => session.id).join(',')}`); return bookmark; },
      rename: async (key: string, id: string, title: string) => { calls.push(`rename:${key}:${id}:${title}`); return renamedBookmark; },
      remove: async (key: string, id: string) => { calls.push(`remove:${key}:${id}`); return bookmark; },
      get: async () => bookmark
    };
    const discovery = {
      // resolve both shared-group agent fixtures
      target: async (id: string) => {
        const selected = [agent, otherAgent].find(candidate => candidate.id === id);
        return selected === undefined ? undefined : { agent: selected, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } };
      },
      // expose one selected Codex conversation
      sessions: async () => [{ id: '0198c333-3333-7333-8333-333333333333', relativePath: 'sessions/2026/08/20/rollout-current-0198c333-3333-7333-8333-333333333333.jsonl' }],
      // expose both dashboard agents
      dashboard: async () => ({ generation: 1, agents: [agent, otherAgent], worktrees: [] })
    };
    const app = await buildApp({ listen: { host: '127.0.0.1', port: 8787 }, name: 'Test', publicOrigin: new URL('https://agents.example.com'), remoteServers: [], trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree, otherWorktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never, bookmarks: bookmarks as never });
    try {
      const headers = await authenticatedHeaders(app);

      const listed = await app.inject({ method: 'GET', url: '/api/worktrees/cora/bookmarks?agentId=agent-1', headers: { host: headers.host, cookie: headers.cookie } });
      const mismatched = await app.inject({ method: 'GET', url: '/api/worktrees/cora/bookmarks?agentId=agent-2', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await app.inject({ method: 'POST', url: '/api/agents/agent-1/bookmarks', headers });
      const renamed = await app.inject({ method: 'PATCH', url: `/api/worktrees/cora/bookmarks/${bookmark.id}`, headers, payload: { title: renamedBookmark.title } });
      const removed = await app.inject({ method: 'DELETE', url: `/api/worktrees/cora/bookmarks/${bookmark.id}`, headers });

      expect(listed.json()).toEqual({ bookmarks: [bookmark], canResume: false, currentBookmarkId: bookmark.id });
      expect(mismatched.json()).toEqual({ bookmarks: [bookmark], canResume: false });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual(bookmark);
      expect(renamed.json()).toEqual(renamedBookmark);
      expect(removed.json()).toEqual(bookmark);
      // require both shared-group list operations
      expect(calls.filter(call => call === 'list:potato')).toHaveLength(2);
      expect(calls).toEqual(expect.arrayContaining([
        'current:0198c333-3333-7333-8333-333333333333',
        'create:potato:0198c333-3333-7333-8333-333333333333',
        `rename:potato:${bookmark.id}:${renamedBookmark.title}`,
        `remove:potato:${bookmark.id}`
      ]));
    } finally {
      await app.close();
    }
  }, 15_000);

  it('keeps scratch bookmarks in one stable workspace group', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: true, command: 'codex' };
    const firstAgent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu', title: 'Scratch' });
    const secondAgent = { ...firstAgent, id: 'scratch-2', paneId: '%2', sessionId: 'socket:$2' };
    const renamedBookmark = { ...bookmark, title: 'Scratch release plan' };
    const calls: string[] = [];
    const bookmarks = {
      list: async (key: string) => { calls.push(`list:${key}`); return [bookmark]; },
      // resolve the selected scratch conversation
      currentThreadId: async () => bookmark.threadId,
      bookmarkCurrent: async (key: string) => { calls.push(`create:${key}`); return bookmark; },
      rename: async (key: string, id: string) => { calls.push(`rename:${key}:${id}`); return renamedBookmark; },
      remove: async (key: string, id: string) => { calls.push(`remove:${key}:${id}`); return bookmark; }
    };
    const discovery = {
      // resolve either scratch agent in the shared workspace
      target: async (id: string) => {
        const agent = [firstAgent, secondAgent].find(candidate => candidate.id === id);
        return agent === undefined ? undefined : { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } };
      },
      // expose one selected Codex conversation
      sessions: async () => [{ id: bookmark.threadId, relativePath: `sessions/2026/08/20/rollout-current-${bookmark.threadId}.jsonl` }],
      dashboard: async () => ({ generation: 1, agents: [firstAgent, secondAgent], worktrees: [] })
    };
    const app = await buildApp({ listen: { host: '127.0.0.1', port: 8787 }, name: 'Test', publicOrigin: new URL('https://agents.example.com'), remoteServers: [], trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 25).toString('base64url')), discovery: discovery as never, bookmarks: bookmarks as never });
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

  it('launches an inactive worktree into the selected bookmarked chat', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', saveKey: 'potato', available: true, pinned: true, command: 'codex' };
    const replacement = stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', worktreeId: 'cora', title: 'Ready' });
    let launched = false;
    const discovery = { target: async () => undefined, dashboard: async () => ({ generation: launched ? 2 : 1, agents: launched ? [replacement] : [], worktrees: [] }) };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, threadId: string) => { launched = worktreeId === 'cora' && threadId === bookmark.threadId; return launched; } };
    const bookmarks = { get: async (key: string, id: string) => key === 'potato' && id === bookmark.id ? bookmark : undefined };
    const app = await buildApp({ listen: { host: '127.0.0.1', port: 8787 }, name: 'Test', publicOrigin: new URL('https://agents.example.com'), remoteServers: [], trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: bookmarks as never, launchPollDelay: async () => undefined });
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
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', saveKey: 'potato', available: true, pinned: true, command: 'codex' };
    const firstAgent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', worktreeId: 'cora', title: 'Ready' });
    const replacement = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let resumed = false;
    const discovery = {
      // expose the replacement after resume
      dashboard: async () => ({ generation: resumed ? 2 : 1, agents: [resumed ? replacement : firstAgent], worktrees: [] }),
      // resolve the original target
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, threadId: string) => { events.push(`resume:${worktreeId}:${threadId}`); resumed = true; return true; } };
    const bookmarks = { get: async () => bookmark };
    const queuedPrompts = { list: async () => [] };
    const app = await buildApp({ listen: { host: '127.0.0.1', port: 8787 }, name: 'Test', publicOrigin: new URL('https://agents.example.com'), remoteServers: [], trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: bookmarks as never, queuedPrompts: queuedPrompts as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, launchPollDelay: async () => undefined });
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
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', saveKey: 'potato', available: true, pinned: true, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', worktreeId: 'cora', title: 'Ready' });
    let closed = false;
    const discovery = { dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }), target: async () => ({ agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } }) };
    const launch = { canResumeConversation: () => false, resumeConversation: async () => false };
    const app = await buildApp({ listen: { host: '127.0.0.1', port: 8787 }, name: 'Test', publicOrigin: new URL('https://agents.example.com'), remoteServers: [], trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 24).toString('base64url')), discovery: discovery as never, launch: launch as never, bookmarks: { get: async () => bookmark } as never, queuedPrompts: { list: async () => [] } as never, tmux: { close: async () => { closed = true; return true; } } as never });
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
});
