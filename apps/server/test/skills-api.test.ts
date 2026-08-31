// `/api/agents/:id/commands` endpoint tests. (Named `skills-api.test.ts` for
// continuity — the deletion hook blocks a rename; the endpoint replaced the old
// `/skills` route.)
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = {
  name: 'Remote Agents',
  remoteServers: [],
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(['127.0.0.1']),
  pollIntervalMs: 500,
  newAgentCommand: 'codex',
  worktrees: [{ id: 'ferry-fyi', label: 'Ferry FYI', path: '/worktrees/ferry.fyi', identity: '/home/ubuntu/ferry.fyi', hostPath: '/home/ubuntu/ferry.fyi', available: true, pinned: true, command: 'codex' }]
};

describe('agent command catalog API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => { await app?.close(); });

  it('serves the catalog for the agent kind, scanning the worktree path and account home', async () => {
    const seen: Array<{ kind: string; workspace: string; home: string }> = [];
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/ferry.fyi', title: 'Ready', kind: 'codex' };
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined } as never,
      launch: { agentHome: () => '/home/ubuntu' } as never,
      commandCatalog: { catalog: async (adapter: { kind: string }, workspace: string, home: string) => { seen.push({ kind: adapter.kind, workspace, home }); return [{ value: '$push', description: 'Review and push.' }, { value: '/help', description: 'Show available commands' }]; } } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/agent-1/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [{ value: '$push', description: 'Review and push.' }, { value: '/help', description: 'Show available commands' }] });
    expect(seen).toEqual([{ kind: 'codex', workspace: '/worktrees/ferry.fyi', home: '/home/ubuntu' }]);
  });

  it('reports 404 for an unknown agent', async () => {
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async () => undefined } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/missing/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(404);
  });
});
