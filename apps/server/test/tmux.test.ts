import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', () => ({ run }));

import { TmuxAdapter } from '../src/tmux/adapter.js';
import { latestAgentMessageFromHistory, latestCompletedAssistantMessage, latestCompletedAssistantTurn } from '../src/adapters/codex-turns.js';

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
    run.mockResolvedValueOnce({ code: 0, stdout: "%1\t$1\trac-stack-owen-a1b2c3\t123\t/home/ubuntu/owen\tbash\tstack\t\texec /bin/bash -lc 'echo ready'\t\t\t\t1\n", stderr: '' });

    await expect(new TmuxAdapter().listPanes(socket)).resolves.toEqual([{
      paneId: '%1',
      sessionId: '$1',
      sessionName: 'rac-stack-owen-a1b2c3',
      pid: 123,
      path: '/home/ubuntu/owen',
      command: 'bash',
      title: 'stack',
      startCommand: "exec /bin/bash -lc 'echo ready'",
      consoleManaged: true,
      socket
    }]);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}\t#{@rac_attention}\t#{@rac_session}\t#{@rac_sandboxed}\t#{@rac_console_managed}']);
  });

  it('labels one exact server-owned pane', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().label(socket, '%1', 'Update Advisor v4 2222222')).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-p', '-t', '%1', '@rac_display_label', 'Update Advisor v4 2222222']);
  });

  it('unsets every reported-state option on one exact pane', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().unsetReportedState(socket, '%1')).resolves.toBe(true);

    for (const option of ['@rac_attention', '@rac_session', '@rac_sandboxed']) {
      expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-p', '-t', '%1', '-u', option]);
    }
    // never touches the server-owned display label
    expect(run).not.toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-p', '-t', '%1', '-u', '@rac_display_label']);
    expect(run).not.toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-p', '-t', '%1', '-u', '@rac_console_managed']);
  });

  it('refuses to unset reported state for an unsafe pane coordinate', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    await expect(new TmuxAdapter().unsetReportedState(socket, 'not-a-pane')).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends an Adapter key sequence one send-keys invocation per key', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().sendKeys(socket, '%1', ['Down', 'Down', 'Enter'])).resolves.toBe(true);

    expect(run.mock.calls).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Down']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Down']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'send-keys', '-t', '%1', 'Enter']],
    ]);
  });

  it('waits after Escape so a following key is not read as a Meta chord', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let escapeAt = 0;
    let ctrlCAt = 0;
    run.mockImplementation((_binary: string, args: string[]) => {
      if (args.at(-1) === 'Escape') escapeAt = performance.now();
      if (args.at(-1) === 'C-c') ctrlCAt = performance.now();
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(new TmuxAdapter().sendKeys(socket, '%1', ['Escape', 'C-c'])).resolves.toBe(true);

    expect(run.mock.calls.map(call => (call[1] as string[]).at(-1))).toEqual(['Escape', 'C-c']);
    expect(ctrlCAt - escapeAt).toBeGreaterThanOrEqual(100);
  });

  it('refuses to send keys for an unsafe pane coordinate or an empty sequence', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    await expect(new TmuxAdapter().sendKeys(socket, 'bad', ['Enter'])).resolves.toBe(false);
    await expect(new TmuxAdapter().sendKeys(socket, '%1', [])).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('writes a console-owned attention state only for a known state word', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await expect(new TmuxAdapter().setReportedAttention(socket, '%1', 'finished')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-p', '-t', '%1', '@rac_attention', 'finished']);

    run.mockClear();
    await expect(new TmuxAdapter().setReportedAttention(socket, '%1', 'bogus' as never)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
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

  it('reads the pane dimensions and the attached clients in one tmux query', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: '220\t86\t220\t80\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 220, rows: 80 });

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', [
      '-S', '/tmp/tmux',
      'display-message', '-p', '-t', '%1', '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}',
      ';',
      'list-clients', '-t', '%1', '-F', '#{client_width}\t#{client_height}\t#{client_flags}\t#{status}'
    ]);
  });

  it('limits the pane to the smallest attached client beneath its status line and companion panes', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    // window 200x50 with 6 rows of companion panes; a 100x30 terminal with one
    // status line and a 140x40 terminal with two
    run.mockResolvedValueOnce({ code: 0, stdout: '200\t50\t200\t44\n100\t30\tattached,focused,UTF-8\ton\n140\t40\tattached,UTF-8\t2\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 200, rows: 44, clientLimit: { cols: 100, rows: 23 } });
  });

  it('skips the clients tmux skips when sizing a window', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    // an unsized control-mode client, a suspended client, and an ignore-size
    // client next to an ordinary 120x40 terminal
    run.mockResolvedValueOnce({ code: 0, stdout: '200\t50\t200\t50\n0\t0\tattached,control-mode,UTF-8\ton\n90\t20\tattached,suspended,UTF-8\ton\n80\t24\tattached,ignore-size,UTF-8\ton\n120\t40\tattached,UTF-8\ton\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 200, rows: 50, clientLimit: { cols: 120, rows: 39 } });
  });

  it('reports a pane that an attached terminal has grown past the request bound', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    // after the console hands the window back to tmux, a 600-column terminal sizes it
    run.mockResolvedValueOnce({ code: 0, stdout: '600\t100\t600\t100\n600\t101\tattached,focused,UTF-8\ton\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 600, rows: 100, clientLimit: { cols: 600, rows: 100 } });
  });

  it('honours an ignore-size client when it is the only one attached', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: '200\t50\t200\t50\n80\t24\tattached,ignore-size,UTF-8\toff\n', stderr: '' });

    await expect(new TmuxAdapter().size(socket, '%1')).resolves.toEqual({ cols: 200, rows: 50, clientLimit: { cols: 80, rows: 24 } });
  });

  it('hands the window size back to tmux when the console stops viewing a pane', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

    await expect(new TmuxAdapter().unpinWindowSize(socket, '%1')).resolves.toBe(true);
    await expect(new TmuxAdapter().unpinWindowSize(socket, 'main')).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'set-option', '-w', '-t', '%1', '-u', 'window-size']);
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

  it('neutralizes tmux format expansion so a run-shell command reaches the shell literally', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const adapter = new TmuxAdapter();
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    // tmux format-expands a run-shell argument before executing it; a `#(…)` in an
    // agent-controlled path (a teardown's `cd -- '<workspace>'`) would otherwise run
    // as a shell substitution. Doubling `#` makes tmux collapse it back to a literal.
    await expect(adapter.runShell(socket, "cd -- '/tmp/x/#(id>/tmp/pwned)' && eval 'rm -f x'")).resolves.toBe(true);
    await expect(adapter.runShell(socket, '')).resolves.toBe(false);
    await expect(adapter.runShell(socket, 'ok\0nul')).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'run-shell', "cd -- '/tmp/x/##(id>/tmp/pwned)' && eval 'rm -f x'"]);
  });

  it('captures only the requested visible history window and resizes the pane for the active client', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run
      .mockResolvedValueOnce({ code: 0, stdout: 'old\ncurrent\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '120\t36\t120\t36\n', stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 2)).resolves.toEqual({ text: 'old\x1b[49m\ncurrent\x1b[49m', older: false });
    await expect(new TmuxAdapter().resize(socket, '%1', 120, 36)).resolves.toBe(true);

    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'capture-pane', '-e', '-p', '-t', '%1', '-S', '-5000']);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}']);
    expect(run).not.toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['resize-window']));
  });

  it('accounts for companion panes when matching the browser output height', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run
      .mockResolvedValueOnce({ code: 0, stdout: '120\t45\t120\t36\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '160\t59\t160\t50\n', stderr: '' });

    await expect(new TmuxAdapter().resize(socket, '%1', 160, 50)).resolves.toBe(true);

    expect(run.mock.calls).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-window', '-t', '%1', '-x', '160', '-y', '59']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-pane', '-t', '%1', '-x', '160', '-y', '50']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}']]
    ]);
  });

  it('corrects a successful tmux resize that was still clamped by a tiled layout', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run
      .mockResolvedValueOnce({ code: 0, stdout: '120\t45\t120\t36\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '160\t59\t160\t48\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '160\t61\t160\t50\n', stderr: '' });

    await expect(new TmuxAdapter().resize(socket, '%1', 160, 50)).resolves.toBe(true);

    expect(run.mock.calls.slice(4)).toEqual([
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-window', '-t', '%1', '-x', '160', '-y', '61']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'resize-pane', '-t', '%1', '-x', '160', '-y', '50']],
      ['/usr/bin/tmux', ['-S', '/tmp/tmux', 'display-message', '-p', '-t', '%1', '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}']]
    ]);
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

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 2)).resolves.toEqual({ text: 'output that is no longer visible\x1b[49m\nlatest output\x1b[49m', older: true, lastPrompt: 'summarize this repository', latestAgentMessage: '• Working\noutput that is no longer visible\nlatest output' });
  });

  it('captures the complete latest agent message when its question choices exceed the viewport', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const history = ['older output', '› choose a deployment target', '', '• Checking environments', '', 'Where should OMX deploy?', '› 1. Staging', '  2. Production', '  3. Preview', '  4. Cancel', ''].join('\n');
    run.mockResolvedValueOnce({ code: 0, stdout: history, stderr: '' });

    expect(latestAgentMessageFromHistory(history)).toBe('• Checking environments\n\nWhere should OMX deploy?\n› 1. Staging\n  2. Production\n  3. Preview\n  4. Cancel');
    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 3)).resolves.toMatchObject({
      text: '  2. Production\x1b[49m\n  3. Preview\x1b[49m\n  4. Cancel\x1b[49m',
      latestAgentMessage: '• Checking environments\n\nWhere should OMX deploy?\n› 1. Staging\n  2. Production\n  3. Preview\n  4. Cancel'
    });
  });

  it('retains the selected first multi-select answer', () => {
    const history = ['› choose cleanup targets', '', 'Which targets should be cleaned?', '› [x] 1. Build output', '  [ ] 2. Test cache', '  [ ] 3. None', ''].join('\n');

    expect(latestAgentMessageFromHistory(history)).toBe('Which targets should be cleaned?\n› [x] 1. Build output\n  [ ] 2. Test cache\n  [ ] 3. None');
  });

  it('retains the cyan selected first answer without treating it as a prompt', () => {
    const history = [
      '› switch from Sendgrid to SES',
      '',
      'Which From address should Auth0 use for verification and account emails?',
      '› \x1b[38;5;6m1. noreply@ferry.fyi (Recommended)\x1b[39m',
      '  2. ansel@santosa.family',
      '  3. admin@whidbey.fyi',
      '  4. None of the above',
      ''
    ].join('\n');

    expect(latestAgentMessageFromHistory(history)).toBe([
      'Which From address should Auth0 use for verification and account emails?',
      '› 1. noreply@ferry.fyi (Recommended)',
      '  2. ansel@santosa.family',
      '  3. admin@whidbey.fyi',
      '  4. None of the above'
    ].join('\n'));
  });

  it('includes a completed assistant response and marks it when it is longer than the viewport', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const response = ['• Summary', '', '  - First detail', '  - Second detail', '  - Third detail', '─ Worked for 5s', '', '› Implement {feature}', ''];
    run.mockResolvedValueOnce({ code: 0, stdout: response.join('\n'), stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 3)).resolves.toMatchObject({
      latestAssistantMessage: 'Summary\n\n- First detail\n- Second detail\n- Third detail',
      latestAssistantMessageOverflows: true
    });
  });

  it('turns green inline highlights into Markdown code without formatting links', () => {
    const history = [
      '• Run \x1b[38;5;6mpnpm test\x1b[39m, then inspect \x1b[36mconfig.json\x1b[39m.',
      '  Open \x1b[4m\x1b[38;5;6mhttps://example.com/results\x1b[0m for the report.',
      '─ Worked for 3s',
      ''
    ].join('\n');

    expect(latestCompletedAssistantMessage(history)?.text).toBe('Run `pnpm test`, then inspect `config.json`.\nOpen https://example.com/results for the report.');
  });

  // parse untimed completion dividers
  it('extracts a completed assistant response without a timing label', () => {
    const history = [
      '› Give guidance',
      '',
      '• Checking local patterns',
      '────────',
      '',
      '• ## Recommendation',
      '',
      '  Keep feature boundaries cohesive.',
      '────────',
      '',
      '• Model changed to gpt-5.6-sol xhigh',
      '',
      '› Implement {feature}',
      ''
    ].join('\n');

    expect(latestCompletedAssistantMessage(history)?.text).toBe('## Recommendation\n\nKeep feature boundaries cohesive.');
  });

  // prefer the newest structural completion style
  it('selects a newer untimed completion after an older timed completion', () => {
    const history = [
      '› Old prompt',
      '',
      '• Old final answer',
      '─ Worked for 1s',
      '',
      '› New prompt',
      '',
      '• New final answer',
      '────────',
      ''
    ].join('\n');

    expect(latestCompletedAssistantTurn(history)).toMatchObject({ prompt: 'New prompt', text: 'New final answer' });
  });

  // reject stale answers after a newer turn begins
  it('does not attach an untimed completion to a newer active prompt', () => {
    const history = [
      '› Old prompt',
      '',
      '• Old final answer',
      '────────',
      '',
      '› New prompt',
      '',
      '• Still working',
      ''
    ].join('\n');

    expect(latestCompletedAssistantTurn(history)).toBeUndefined();
  });

  // associate selected choices with their original prompt
  it('skips numbered and multi-select choices while matching the completed turn', () => {
    const history = [
      '› Original request',
      '',
      '• Choose the implementation scope',
      '› 1. Focused change',
      '  2. Broader refactor',
      '› [x] 1. Include validation',
      '  [ ] 2. Skip validation',
      '',
      '• Final answer',
      '',
      '  Completed the focused change.',
      '────────',
      ''
    ].join('\n');

    expect(latestCompletedAssistantTurn(history)).toMatchObject({ prompt: 'Original request', text: 'Final answer\n\nCompleted the focused change.' });
  });

  it('includes a completed assistant response that fits in the viewport without marking it as overflowing', async () => {
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    run.mockResolvedValueOnce({ code: 0, stdout: ['• Summary', '  One detail', '  Another detail', '─ Worked for 2s', ''].join('\n'), stderr: '' });

    await expect(new TmuxAdapter().captureWindow(socket, '%1', 0, 3)).resolves.toMatchObject({
      latestAssistantMessage: 'Summary\nOne detail\nAnother detail',
      latestAssistantMessageOverflows: false
    });
  });

  it('does not report the previous completion after a newer response starts', () => {
    const history = ['• Previous response', '─ Worked for 2s', '', '› New request', '', '• Working on it', ''].join('\n');

    expect(latestCompletedAssistantMessage(history)).toBeUndefined();
  });
});
