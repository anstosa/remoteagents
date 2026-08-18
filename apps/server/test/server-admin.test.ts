import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedConfig } from '../src/config/schema.js';
import { ServerAdminService } from '../src/server-admin/service.js';

const config: ValidatedConfig = { name: 'Framework', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://framework.example.com'), trustedProxyIps: new Set(['127.0.0.1']), pollIntervalMs: 500, newAgentCommand: 'codex', worktrees: [] };

describe('server administration', () => {
  let root: string | undefined;
  // remove isolated state
  afterEach(async () => {
    // clean only a created fixture
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('renames the persisted server without changing other configuration', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-server-admin-'));
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ name: 'Framework', publicOrigin: 'https://framework.example.com', worktrees: [{ id: 'remoteagents' }] }));
    const service = new ServerAdminService(config, { configWritePath: configPath, statusDirectory: root });

    expect(await service.renameServer('  Garage Server  ')).toBe('Garage Server');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ name: 'Garage Server', publicOrigin: 'https://framework.example.com', worktrees: [{ id: 'remoteagents' }] });
    expect(await service.renameServer('   ')).toBeUndefined();
  });

  it('launches only the fixed updater through the host tmux bridge', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-server-admin-'));
    const runCommand = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const service = new ServerAdminService(config, { configWritePath: join(root, 'config.json'), hostRepository: '/home/ubuntu/remoteagents', statusDirectory: root, tmuxBinary: '/usr/local/bin/host-tmux', tmuxSocket: '/host-tmux/default', runCommand });

    const update = await service.startUpdate();

    expect(update).toMatchObject({ kind: 'update', state: 'queued' });
    expect(update?.id).toMatch(/^[A-Za-z0-9_-]{20,64}$/u);
    expect(runCommand).toHaveBeenCalledWith('/usr/local/bin/host-tmux', ['-S', '/host-tmux/default', 'new-session', '-d', '-s', expect.stringMatching(/^rac-update-/u), '-c', '/home/ubuntu/remoteagents', '/bin/bash', '/home/ubuntu/remoteagents/scripts/update-server.sh', update?.id], undefined, 5_000);
    expect(await service.updateStatus(update!.id)).toEqual(update);
    expect(await service.updateStatus('../../config')).toBeUndefined();
  });

  it('reuses one queued update across concurrent restart requests', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-server-admin-'));
    const runCommand = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const service = new ServerAdminService(config, { hostRepository: '/home/ubuntu/remoteagents', statusDirectory: root, tmuxSocket: '/host-tmux/default', runCommand });

    const [first, second] = await Promise.all([service.startUpdate(), service.startUpdate()]);
    const repeated = await service.startUpdate();

    expect(second).toEqual(first);
    expect(repeated).toEqual(first);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('records a failed launch without running arbitrary fallback commands', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-server-admin-'));
    const runCommand = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no tmux' }));
    const service = new ServerAdminService(config, { hostRepository: '/host/repo', statusDirectory: root, tmuxSocket: '/host-tmux/default', runCommand });

    const update = await service.startUpdate();

    expect(update?.state).toBe('failed');
    expect(await service.updateStatus(update!.id)).toEqual(update);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('rechecks origin main through the fixed host script', async () => {
    root = await mkdtemp(join(tmpdir(), 'rac-server-admin-'));
    const statusPath = join(root, 'server-update-availability.json');
    let state: 'available' | 'current' = 'available';
    // publish the host script result
    const runCommand = vi.fn(async () => {
      await writeFile(statusPath, `${JSON.stringify({ kind: 'update-availability', state })}\n`);
      return { code: 0, stdout: '', stderr: '' };
    });
    const service = new ServerAdminService(config, { hostRepository: '/host/repo', statusDirectory: root, tmuxBinary: '/usr/local/bin/host-tmux', tmuxSocket: '/host-tmux/default', runCommand });

    await expect(service.updateAvailable()).resolves.toBe(true);
    state = 'current';
    await expect(service.updateAvailable()).resolves.toBe(false);

    expect(runCommand).toHaveBeenCalledWith('/usr/local/bin/host-tmux', ['-S', '/host-tmux/default', 'run-shell', "/bin/bash '/host/repo/scripts/check-server-update.sh'"], undefined, 30_000);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
