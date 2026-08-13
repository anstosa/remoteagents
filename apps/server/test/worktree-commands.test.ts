import { afterEach, describe, expect, it } from 'vitest';
import type { ValidatedConfig } from '../src/config/schema.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';

const previousTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex', commands: { build: 'docker compose build' } };
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] };

afterEach(() => {
  if (previousTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = previousTmuxDirectory;
});

describe('worktree stack commands', () => {
  it('reports the active operation until its tmux session exits', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    let active = true;
    let session = '';
    const command = async (_binary: string, args: string[]) => {
      if (args.includes('new-session')) {
        session = args[args.indexOf('-s') + 1] ?? '';
        return { code: 0, stdout: '' };
      }
      if (args.includes('has-session')) return { code: active ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, command);

    await expect(service.run(worktree.id, 'build')).resolves.toBe(true);
    expect(session).toMatch(/^rac-stack-cora-build-/);
    await expect(service.state(worktree)).resolves.toEqual({ operation: 'build' });
    active = false;
    await expect(service.state(worktree)).resolves.toEqual({});
  });
});
