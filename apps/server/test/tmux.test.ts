import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { TmuxAdapter } from '../src/tmux/adapter.js';

describe('TmuxAdapter capture', () => {
  beforeEach(() => {
    run.mockReset();
    run.mockResolvedValue({ code: 0, stdout: 'Codex UI\n', stderr: '' });
  });

  it('captures plain snapshots rather than replayable terminal escape sequences', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    run.mockResolvedValueOnce({ code: 0, stdout: '\x1b[38;2;137;180;250mCodex UI\x1b[0m\n\x1b[?1049hmenu\x1b[?1049l\x1b]8;;https://example.com\x07link\x1b]8;;\x07', stderr: '' });

    await expect(new TmuxAdapter().capture(socket, '%1')).resolves.toBe('\x1b[38;2;137;180;250mCodex UI\x1b[0m\x1b[49m\nmenulink\x1b[49m');

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-e', '-p', '-t', '%1', '-S', '-800']);
  });

  it('reports the tmux session name used to distinguish internal command panes', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: "%1\t$1\trac-stack-owen-a1b2c3\t123\t/home/ubuntu/owen\tbash\tstack\t\texec /bin/bash -lc 'echo ready'\n", stderr: '' });

    await expect(new TmuxAdapter().listPanes(socket)).resolves.toEqual([{
      paneId: '%1',
      sessionId: '$1',
      sessionName: 'rac-stack-owen-a1b2c3',
      pid: 123,
      path: '/home/ubuntu/owen',
      command: 'bash',
      title: 'stack',
      startCommand: "exec /bin/bash -lc 'echo ready'",
      socket
    }]);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}']);
  });

  it('confirms Codex choices from the initially selected first option', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().selectOption(socket, '%1', 2)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Down', 'Down', 'Enter']);
  });

  it('suspends the foreground agent so the pane shell can become interactive', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run
      .mockResolvedValueOnce({ code: 0, stdout: '123\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'bash\n', stderr: '' });

    await expect(new TmuxAdapter().suspend(socket, '%1')).resolves.toBe(true);

    expect(run.mock.calls).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{pane_pid}']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'C-z']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{pane_current_command}']]
    ]);
  });

  it('resumes an agent when its pane has no interactive shell to reclaim the terminal', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run
      .mockResolvedValueOnce({ code: 0, stdout: '123\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    for (let attempt = 0; attempt < 20; attempt += 1) run.mockResolvedValueOnce({ code: 0, stdout: 'node\n', stderr: '' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await expect(new TmuxAdapter().suspend(socket, '%1')).resolves.toBe(false);

    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', [
      '-S', '/tmp/tmux', 'run-shell',
      `tpgid="$(ps -o tpgid= -p 123 | tr -d ' ')" && case "$tpgid" in ''|*[!0-9]*) exit 1;; esac && kill -CONT -- "-$tpgid"`
    ]);
  });

  it('clears the shell line and foregrounds the suspended agent job', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().foreground(socket, '%1')).resolves.toBe(true);

    expect(run.mock.calls.slice(-2)).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', '\x15fg']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Enter']]
    ]);
  });

  it('reads the current pane dimensions before a temporary browser resize', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: '220\t80\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 220, rows: 80 });

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{pane_width}\t#{pane_height}']);
  });

  it('quits Neovim review mode instead of foregrounding over it', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: 'nvim\n', stderr: '' });

    await expect(new TmuxAdapter().quitReview(socket, '%1')).resolves.toBe(true);

    expect(run.mock.calls.slice(-3)).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{pane_current_command}']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', '\x1b:qa!']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Enter']]
    ]);
  });

  it('treats an already-closed review as complete without typing into the resumed agent', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: 'node\n', stderr: '' });

    await expect(new TmuxAdapter().quitReview(socket, '%1')).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{pane_current_command}']);
  });

  it('closes the entire replaced session so companion HUD panes do not linger', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().closeSession(socket, '$1')).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'kill-session', '-t', '$1']);
  });

  it('terminates only a validated numeric host pid through the tmux server', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const adapter = new TmuxAdapter();

    await expect(adapter.terminateHostProcess(socket, 4321)).resolves.toBe(true);
    await expect(adapter.terminateHostProcess(socket, Number.NaN)).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'run-shell', 'kill -TERM -- 4321']);
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

  it('moves unused rows above a short capture so the frame stays bottom aligned', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValue({ code: 0, stdout: 'first\nsecond\n\n\n', stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 4)).resolves.toEqual({
      text: '\x1b[49m\n\x1b[49m\nfirst\x1b[49m\nsecond\x1b[49m',
      older: false
    });
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

  it('sends Ctrl+C as an explicit tmux key', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().input(socket, '%1', '\x03')).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'C-c']);
  });

  it('submits terminal-mode commands with tmux’s Enter key', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().input(socket, '%1', '! git s\r')).resolves.toBe(true);

    expect(run.mock.calls.slice(-2)).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', '! git s']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Enter']]
    ]);
  });

  it('serializes browser input so Enter cannot overtake command text', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    run.mockImplementationOnce(async () => {
      await firstPending;
      return { code: 0, stdout: '', stderr: '' };
    });
    const adapter = new TmuxAdapter();

    const inputs = [
      adapter.input(socket, '%1', '!'),
      adapter.input(socket, '%1', ' git status'),
      adapter.input(socket, '%1', '\r')
    ];

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    releaseFirst();
    await expect(Promise.all(inputs)).resolves.toEqual([true, true, true]);
    expect(run.mock.calls).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', '!']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-l', '-t', '%1', ' git status']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Enter']]
    ]);
  });
});

describe('TmuxAdapter prompt history', () => {
  it('includes the latest completed prompt even when it is outside the visible page', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: '› summarize this repository\n• Working\noutput that is no longer visible\nlatest output\n', stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 2)).resolves.toEqual({ text: 'output that is no longer visible\x1b[49m\nlatest output\x1b[49m', older: true, lastPrompt: 'summarize this repository' });
  });
});
