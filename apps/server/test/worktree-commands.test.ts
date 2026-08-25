import { afterEach, describe, expect, it } from 'vitest';
import type { ValidatedConfig } from '../src/config/schema.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';

const previousTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const previousTmuxBinary = process.env.RAC_TMUX_BIN;
const previousHostPath = process.env.RAC_HOST_PATH;
const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex', commands: { build: 'docker compose build' } };
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [worktree] };

afterEach(() => {
  // restore the host socket setting
  if (previousTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = previousTmuxDirectory;
  // restore the host tmux client setting
  if (previousTmuxBinary === undefined) delete process.env.RAC_TMUX_BIN;
  else process.env.RAC_TMUX_BIN = previousTmuxBinary;
  // restore the host executable path setting
  if (previousHostPath === undefined) delete process.env.RAC_HOST_PATH;
  else process.env.RAC_HOST_PATH = previousHostPath;
});

describe('worktree stack commands', () => {
  it('reports the active operation until its tmux session exits', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_TMUX_BIN = '/host-tools/tmux';
    process.env.RAC_HOST_PATH = '/opt/operator/bin:/usr/bin:/bin';
    let active = true;
    let session = '';
    const binaries: string[] = [];
    const command = async (binary: string, args: string[]) => {
      binaries.push(binary);
      // capture the launched operation
      if (args.includes('new-session')) {
        session = args[args.indexOf('-s') + 1] ?? '';
        expect(args.at(-1)).toContain("export PATH='/opt/operator/bin:/usr/bin:/bin'");
        return { code: 0, stdout: '' };
      }
      // report the synthetic session state
      if (args.includes('has-session')) return { code: active ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, command);

    await expect(service.run(worktree.id, 'build')).resolves.toBe(true);
    expect(session).toMatch(/^rac-stack-cora-build-/);
    await expect(service.state(worktree)).resolves.toEqual({ operation: 'build' });
    active = false;
    await expect(service.state(worktree)).resolves.toEqual({});
    expect(new Set(binaries)).toEqual(new Set(['/host-tools/tmux']));
  });
});
