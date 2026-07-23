import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { TmuxAdapter } from '../src/tmux/adapter.js';

describe('TmuxAdapter capture', () => {
  beforeEach(() => run.mockResolvedValue({ code: 0, stdout: 'Codex UI\n', stderr: '' }));

  it('captures plain snapshots rather than replayable terminal escape sequences', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    run.mockResolvedValueOnce({ code: 0, stdout: '\x1b[38;2;137;180;250mCodex UI\x1b[0m\n\x1b[?1049hmenu\x1b[?1049l\x1b]8;;https://example.com\x07link\x1b]8;;\x07', stderr: '' });

    await expect(new TmuxAdapter().capture(socket, '%1')).resolves.toBe('\x1b[38;2;137;180;250mCodex UI\x1b[0m\x1b[49m\nmenulink\x1b[49m');

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-e', '-p', '-t', '%1', '-S', '-800']);
  });

  it('confirms Codex choices from the initially selected first option', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().selectOption(socket, '%1', 2)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Down', 'Down', 'Enter']);
  });

  it('captures only the requested visible history window and resizes the pane for the active client', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: 'old\ncurrent\n', stderr: '' }).mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 2)).resolves.toEqual({ text: 'old\x1b[49m\ncurrent\x1b[49m', older: false });
    await expect(new TmuxAdapter().resize(socket, '%1', 120, 36)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-e', '-p', '-t', '%1', '-S', '-5000']);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-window', '-t', '%1', '-x', '120', '-y', '36']);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-pane', '-t', '%1', '-x', '120', '-y', '36']);
  });

  it('slices concrete history lines so adjacent pages preserve their boundary', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValue({ code: 0, stdout: 'one\ntwo\nthree\nfour\nfive\nsix\n', stderr: '' });

    const adapter = new TmuxAdapter();
    await expect(adapter.captureWindow(socket, '%1', 0, 3)).resolves.toEqual({ text: 'four\x1b[49m\nfive\x1b[49m\nsix\x1b[49m', older: true });
    await expect(adapter.captureWindow(socket, '%1', 2, 3)).resolves.toEqual({ text: 'two\x1b[49m\nthree\x1b[49m\nfour\x1b[49m', older: true });
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-e', '-p', '-t', '%1', '-S', '-5000']);
  });

  it('sends literal input without attaching or resizing the tmux session', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().input(socket, '%1', '\x1b[A')).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', '\x1b[A']);
  });
});
