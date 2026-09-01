import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { testConfig, testWorktree } from './helpers/config.js';

// mirror the service's tmux-safe session token: `<projectId>-<sha256(path)[0:12]>`
const stackSession = (projectId: string, path: string) => `rac-stack-${projectId}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}-build-exclusive`;

const previousTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const previousTmuxBinary = process.env.RAC_TMUX_BIN;
const previousHostPath = process.env.RAC_HOST_PATH;
const worktree = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, commands: { build: 'docker compose build' } });
const config = testConfig();
const discovery = { worktreesNow: () => [worktree] };

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
    const service = new WorktreeCommandService(config, discovery as never, command);

    await expect(service.run(worktree.id, 'build')).resolves.toBe(true);
    // session/file names use a tmux-safe `<projectId>-<hash>` token, not the path-bearing wire id
    expect(session).toMatch(/^rac-stack-proj-[0-9a-f]{12}-build-exclusive$/);
    await expect(service.state(worktree)).resolves.toEqual({ operation: 'build' });
    active = false;
    await expect(service.state(worktree)).resolves.toEqual({});
    expect(new Set(binaries)).toEqual(new Set(['/host-tools/tmux']));
  });

  it('detects a running stack operation but ignores transient status probes (Remove blocker)', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const other = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', hostPath: '/home/ubuntu/dana', pinned: false });
    const { createHash } = await import('node:crypto');
    const probeSession = `rac-stack-proj-${createHash('sha256').update(worktree.path).digest('hex').slice(0, 12)}-a1b2c3d4e5f6`;
    const command = async (_binary: string, args: string[]) => {
      // an exclusive operation session for `worktree`, plus unrelated + probe sessions
      if (args.includes('list-sessions')) return { code: 0, stdout: `${stackSession('proj', worktree.path)}\nrac-launch-x\nsome-shell\n` };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);
    // only the Worktree whose exclusive operation session is present is blocked
    await expect(service.sessionRunning(worktree)).resolves.toBe(true);
    await expect(service.sessionRunning(other)).resolves.toBe(false);

    // a transient `rac-stack-<token>-<hex>` status probe is not an operation and never blocks
    const probing = async (_binary: string, args: string[]) => (args.includes('list-sessions') ? { code: 0, stdout: `${probeSession}\n` } : { code: 1, stdout: '' });
    await expect(new WorktreeCommandService(config, discovery as never, probing).sessionRunning(worktree)).resolves.toBe(false);
  });

  it('reports no stack session without the host tmux socket', async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const service = new WorktreeCommandService(config, discovery as never, async () => ({ code: 0, stdout: 'rac-stack-proj-anything\n' }));
    await expect(service.sessionRunning(worktree)).resolves.toBe(false);
  });
});
