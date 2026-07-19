import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { TmuxAdapter } from '../src/tmux/adapter.js';

describe('TmuxAdapter capture', () => {
  beforeEach(() => run.mockResolvedValue({ code: 0, stdout: 'Codex UI\n', stderr: '' }));

  it('captures plain snapshots rather than replayable terminal escape sequences', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().capture(socket, '%1')).resolves.toBe('Codex UI\n');

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-p', '-t', '%1', '-S', '-800']);
  });
});
