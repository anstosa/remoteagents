import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const config: ValidatedConfig = {
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(['127.0.0.1']),
  pollIntervalMs: 500,
  newAgentCommand: 'codex',
  worktrees: [{ id: 'ferry-fyi', label: 'Ferry FYI', path: '/worktrees/ferry.fyi', identity: '/home/ubuntu/ferry.fyi', hostPath: '/home/ubuntu/ferry.fyi', available: true, pinned: true, command: 'codex' }]
};

describe('agent skill API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => { await app?.close(); });

  it('discovers skills through the configured container worktree path', async () => {
    const roots: string[] = [];
    const agent = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/ferry.fyi', title: 'Ready' };
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined } as never,
      skills: { list: async (root: string) => { roots.push(root); return [{ name: 'push', description: 'Review and push.' }]; } } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/agent-1/skills', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skills: [{ name: 'push', description: 'Review and push.' }] });
    expect(roots).toEqual(['/worktrees/ferry.fyi']);
  });
});
