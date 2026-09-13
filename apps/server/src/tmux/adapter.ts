import type { Pane, SocketRef } from '../domain/models.js';
import { lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantMessage } from '../adapters/codex-turns.js';
import type { AttentionState, TmuxKey } from '../adapters/types.js';
import { capturePaneArgs, paneIdPattern as paneId, run, sessionIdPattern as sessionId, tmuxBinary } from './command.js';

const attentionStates: ReadonlySet<string> = new Set(['working', 'finished', 'question']);

// a chord written in one send-keys is read as Meta; wait this long after Escape
const postEscapeDelayMs = 120;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function safeSnapshot(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\x1b') {
      const next = value[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < value.length && (value.charCodeAt(end) < 0x40 || value.charCodeAt(end) > 0x7e)) end += 1;
        if (value[end] === 'm') result += value.slice(index, end + 1);
        index = end < value.length ? end : value.length;
        continue;
      }
      if (next === ']' || next === 'P' || next === '^' || next === '_') {
        index += 1;
        while (index + 1 < value.length && value[index] !== '\x07' && !(value[index] === '\x1b' && value[index + 1] === '\\')) index += 1;
        if (value[index] === '\x1b') index += 1;
        continue;
      }
      index += next === undefined ? 0 : 1;
      continue;
    }
    if (character >= '\x20' || character === '\n' || character === '\r' || character === '\t') result += character;
  }
  const trimmed = result.replace(/(?:[ \t]*\r?\n)+[ \t]*$/u, '');
  return trimmed && `${trimmed.replace(/\r?\n/g, '\x1b[49m\n')}\x1b[49m`;
}

function bottomAlignedWindow(lines: string[], rows: number): string[] {
  // tmux returns unused rows after the pane content. Move that space above
  // the content so a short browser frame remains anchored to the bottom.
  let contentEnd = lines.length;
  while (contentEnd > 0) {
    const visible = safeSnapshot(lines[contentEnd - 1]!).replace(/\x1b\[[0-?]*[ -/]*m/gu, '').trim();
    if (visible) break;
    contentEnd -= 1;
  }
  const content = lines.slice(0, contentEnd);
  return [...Array.from({ length: Math.max(0, rows - content.length) }, () => ''), ...content];
}

export type CapturedWindow = { text: string; older: boolean; lastPrompt?: string; latestAgentMessage?: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean };

// Run a `capture-pane` for a pane at the given scrollback depth and return its raw
// stdout, or undefined on failure. The default spawns a tmux process; the log socket
// passes one that issues the capture over its control-mode connection (ADR 0008), so
// the live view captures with no process spawn while the processing below is shared.
export type PaneCaptureRunner = (depth: number) => Promise<string | undefined>;

export type PaneSize = { cols: number; rows: number };
// clientLimit: the largest pane size every tmux client attached to the pane's
// session can display; absent when nothing is attached
export type PaneGeometry = PaneSize & { clientLimit?: PaneSize };
// The console imposes no size ceiling of its own; the only bound is tmux's own maximum
// window dimension (WINDOW_MAXIMUM, 10000). A pane tmux has already made larger (a wide
// attached terminal) is still reported as it is. (Sizing, ADR 0008: the old 500x300 clamp
// is gone.)
export const paneSizeLimit: PaneSize = { cols: 10_000, rows: 10_000 };

type Layout = { windowCols: number; windowRows: number; paneCols: number; paneRows: number };
const layoutFormat = '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}';
// one attached client per line: tty width, tty height, flags, its session's status-line setting
const clientFormat = '#{client_width}\t#{client_height}\t#{client_flags}\t#{status}';

function parseLayout(line: string | undefined): Layout | undefined {
  const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)$/u.exec(line ?? '');
  if (match === null) return undefined;
  return { windowCols: Number(match[1]), windowRows: Number(match[2]), paneCols: Number(match[3]), paneRows: Number(match[4]) };
}

// `status` is off, on, or a line count
const statusLines = (status: string): number => status === 'off' ? 0 : status === 'on' ? 1 : Number.parseInt(status, 10) || 1;

// Mirror tmux's own ignore_client_size(): suspended clients do not count, and an
// ignore-size client counts only when no other client is attached. The console's
// own control-mode client (ADR 0008) attaches with `ignore-size` and never declares
// a size, but tmux still lists it, sometimes with a phantom 80x24; it is never a real
// viewport, so it is dropped outright rather than allowed to clamp every pane to
// 80x24. tmux sizes a window to the space beneath each client's status line, and the
// console sizes a pane to the window minus its companion panes, so both come off the limit.
function clientLimit(layout: Layout, lines: string[]): PaneSize | undefined {
  const clients = lines.flatMap(line => {
    const match = /^(\d+)\t(\d+)\t([^\t]*)\t([^\t]*)$/u.exec(line);
    if (match === null) return [];
    const flags = new Set(match[3]!.split(','));
    const ttyCols = Number(match[1]);
    const ttyRows = Number(match[2]);
    if (flags.has('suspended') || flags.has('control-mode') || ttyCols < 2 || ttyRows < 2) return [];
    return [{ cols: ttyCols, rows: ttyRows - statusLines(match[4]!), ignored: flags.has('ignore-size') }];
  });
  const counted = clients.some(client => !client.ignored) ? clients.filter(client => !client.ignored) : clients;
  if (counted.length === 0) return undefined;
  const extraCols = Math.max(0, layout.windowCols - layout.paneCols);
  const extraRows = Math.max(0, layout.windowRows - layout.paneRows);
  return {
    cols: Math.max(2, Math.min(...counted.map(client => client.cols)) - extraCols),
    rows: Math.max(2, Math.min(...counted.map(client => client.rows)) - extraRows)
  };
}

export class TmuxAdapter {
  private readonly binary = tmuxBinary();
  private readonly inputQueues = new Map<string, Promise<boolean>>();

  // read pane identity and console-owned launch metadata
  async listPanes(socket: SocketRef): Promise<Pane[]> {
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}\t#{@rac_attention}\t#{@rac_session}\t#{@rac_sandboxed}\t#{@rac_question}\t#{@rac_console_managed}\t#{@rac_role}\t#{@rac_pane_name}']);
    if (out.code !== 0) return [];
    return out.stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
      const [id, session, name, pid, path, command, title, displayLabel, startCommand, attention, sessionRef, sandboxed, question, consoleManaged, role, paneName] = line.split('\t');
      return paneId.test(id) && sessionId.test(session) && name && /^\d+$/.test(pid) && path ? [{ paneId: id, sessionId: session, sessionName: name, pid: Number(pid), path, command: command ?? '', title: title ?? '', ...(displayLabel ? { displayLabel } : {}), ...(startCommand ? { startCommand } : {}), ...(attention ? { reportedAttention: attention } : {}), ...(sessionRef ? { reportedSession: sessionRef } : {}), ...(sandboxed ? { reportedSandboxed: sandboxed } : {}), ...(question ? { reportedQuestion: question } : {}), ...(consoleManaged === '1' ? { consoleManaged: true } : {}), ...(role ? { role } : {}), ...(paneName ? { paneName } : {}), socket }] : [];
    });
  }

  // the pane ids of one tmux session, for the pane socket's membership check: a pane may
  // be streamed only if it belongs to the target Agent's session (Decided at charting).
  // A fresh listing on every socket open, so a pane split by hand in an attached terminal
  // is pickable and a stale id is refused.
  async sessionPaneIds(socket: SocketRef, session: string): Promise<string[]> {
    if (!sessionId.test(session)) return [];
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-s', '-t', session, '-F', '#{pane_id}']);
    if (out.code !== 0) return [];
    return out.stdout.split('\n').map(line => line.trim()).filter(id => paneId.test(id));
  }

  // clear the console-owned reported-state options once a pane's agent is gone
  async unsetReportedState(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    const results = await Promise.all(['@rac_attention', '@rac_session', '@rac_sandboxed', '@rac_question'].map(
      option => run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', option])
    ));
    return results.every(result => result.code === 0);
  }

  // Mark a pane as a Console shell (ADR 0001 style): `@rac_role=shell` so launch adoption,
  // Remove's blind kill and cleanup all skip it, and `@rac_pane_name` (the picker's name,
  // empty by default). Both are set at creation so a restart rediscovers the shell from them.
  async markConsoleShell(socket: SocketRef, pane: string, name: string): Promise<boolean> {
    if (!paneId.test(pane) || name.length > 120 || /[\0\r\n]/u.test(name)) return false;
    if ((await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_role', 'shell'])).code !== 0) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_pane_name', name])).code === 0;
  }

  // Open a Console shell in a new detached window of an existing session, cwd the Worktree,
  // running the given login-shell argv, and mark it. Returns the new pane id, or undefined on
  // failure. The window is detached (`-d`) so an attached terminal is not yanked to it (spec).
  async createConsoleShellWindow(socket: SocketRef, session: string, cwd: string, shellArgv: readonly string[], name: string): Promise<string | undefined> {
    if (!sessionId.test(session) && !/^[A-Za-z0-9_@%+=:,./-]+$/u.test(session)) return undefined;
    const created = await run(this.binary, ['-S', socket.path, 'new-window', '-d', '-t', session, '-c', cwd, '-P', '-F', '#{pane_id}', '--', ...shellArgv]);
    if (created.code !== 0) return undefined;
    const pane = created.stdout.trim();
    if (!paneId.test(pane)) return undefined;
    if (await this.markConsoleShell(socket, pane, name)) return pane;
    // an unmarked shell would be adopted by a later Launch (it looks like an idle landing
    // shell); end it rather than leak an operator-owned pane the console cannot see
    await this.close(socket, pane);
    return undefined;
  }

  // rename one Console shell: write (or clear, when empty) its `@rac_pane_name` option, the
  // name the picker shows. Rejects control characters and an over-long name; an empty name
  // unsets the option so the picker falls back to `command · ~/path`.
  async renamePaneName(socket: SocketRef, pane: string, name: string): Promise<boolean> {
    if (!paneId.test(pane) || name.length > 120 || /[\0\r\n]/u.test(name)) return false;
    const args = name === ''
      ? ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', '@rac_pane_name']
      : ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_pane_name', name];
    return (await run(this.binary, args)).code === 0;
  }

  // assign one server-owned pane label
  async label(socket: SocketRef, pane: string, label: string): Promise<boolean> {
    // reject unsafe pane coordinates and control characters
    if (!paneId.test(pane) || label.length === 0 || label.length > 120 || /[\0\r\n]/u.test(label)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_display_label', label])).code === 0;
  }

  async capture(socket: SocketRef, pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, ...capturePaneArgs(pane, 800)]);
    return out.code === 0 ? safeSnapshot(out.stdout).slice(-96_000) : undefined;
  }

  // capture a pane's scrollback to the given depth, spawning a tmux process unless a
  // control-connection runner is supplied (ADR 0008)
  private async captureText(socket: SocketRef, pane: string, depth: number, captureVia?: PaneCaptureRunner): Promise<string | undefined> {
    if (captureVia !== undefined) return await captureVia(depth);
    const out = await run(this.binary, ['-S', socket.path, ...capturePaneArgs(pane, depth)]);
    return out.code === 0 ? out.stdout : undefined;
  }

  // capture only the current browser window
  async captureRecentWindow(socket: SocketRef, pane: string, rows: number, captureVia?: PaneCaptureRunner): Promise<CapturedWindow | undefined> {
    // reject unsafe pane coordinates
    if (!paneId.test(pane) || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return undefined;
    const depth = Math.min(300, rows + 24);
    const stdout = await this.captureText(socket, pane, depth, captureVia);
    // reject failed captures
    if (stdout === undefined) return undefined;
    const lines = stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const start = Math.max(0, lines.length - rows);
    const window = bottomAlignedWindow(lines.slice(start), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0 };
  }

  async captureWindow(socket: SocketRef, pane: string, history: number, rows: number, captureVia?: PaneCaptureRunner): Promise<CapturedWindow | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(history) || history < 0 || history > 5_000 || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return undefined;
    // tmux's -S/-E coordinates shift around wrapped and blank rows. Capture a
    // bounded history snapshot and slice its concrete lines instead, so page
    // offsets are stable and adjacent windows overlap exactly as requested.
    const stdout = await this.captureText(socket, pane, 5_000, captureVia);
    if (stdout === undefined) return undefined;
    const lines = stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const maximumOffset = Math.max(0, lines.length - rows);
    const offset = Math.min(history, maximumOffset);
    const end = lines.length - offset;
    const start = Math.max(0, end - rows);
    const lastPrompt = lastPromptFromHistory(stdout);
    const latestAgentMessage = latestAgentMessageFromHistory(stdout);
    const assistantMessage = latestCompletedAssistantMessage(stdout);
    const latestAssistantMessage = assistantMessage !== undefined && assistantMessage.text.length <= 30_000 ? assistantMessage.text : undefined;
    const latestAssistantMessageOverflows = assistantMessage === undefined || latestAssistantMessage === undefined ? undefined : assistantMessage.rows > rows;
    const window = bottomAlignedWindow(lines.slice(start, end), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0, ...(lastPrompt === undefined ? {} : { lastPrompt }), ...(latestAgentMessage === undefined ? {} : { latestAgentMessage }), ...(latestAssistantMessage === undefined ? {} : { latestAssistantMessage, latestAssistantMessageOverflows }) };
  }

  async resize(socket: SocketRef, pane: string, cols: number, rows: number): Promise<boolean> {
    if (!paneId.test(pane) || !Number.isInteger(cols) || cols < 2 || cols > paneSizeLimit.cols || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return false;
    const readLayout = async () => {
      const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, layoutFormat]);
      return out.code === 0 ? parseLayout(out.stdout.trim()) : undefined;
    };
    const apply = async (windowCols: number, windowRows: number) => {
      if (windowCols < 2 || windowRows < 2) return false;
      if ((await run(this.binary, ['-S', socket.path, 'resize-window', '-t', pane, '-x', String(windowCols), '-y', String(windowRows)])).code !== 0) return false;
      return (await run(this.binary, ['-S', socket.path, 'resize-pane', '-t', pane, '-x', String(cols), '-y', String(rows)])).code === 0;
    };

    const before = await readLayout();
    if (before === undefined) return false;
    if (before.paneCols === cols && before.paneRows === rows) return true;

    // A worktree window can contain HUD or worker panes. Those panes and their
    // borders consume part of the window, so making the whole window the same
    // size as the browser leaves the agent pane too short. Preserve the
    // non-agent portion of each axis and size the target pane exactly.
    const extraCols = Math.max(0, before.windowCols - before.paneCols);
    const extraRows = Math.max(0, before.windowRows - before.paneRows);
    if (!await apply(cols + extraCols, rows + extraRows)) return false;

    const after = await readLayout();
    if (after === undefined) return false;
    if (after.paneCols === cols && after.paneRows === rows) return true;

    // Some tiled layouts redistribute space during the first window resize.
    // Correct once using the observed delta rather than accepting tmux's
    // successful-but-clamped resize-pane result.
    if (!await apply(after.windowCols + cols - after.paneCols, after.windowRows + rows - after.paneRows)) return false;
    const corrected = await readLayout();
    return corrected?.paneCols === cols && corrected.paneRows === rows;
  }

  async size(socket: SocketRef, pane: string): Promise<PaneGeometry | undefined> {
    if (!paneId.test(pane)) return undefined;
    // one tmux process answers both questions; the layout line comes first
    const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, layoutFormat, ';', 'list-clients', '-t', pane, '-F', clientFormat]);
    if (out.code !== 0) return undefined;
    const [first, ...clients] = out.stdout.split('\n').filter(line => line !== '');
    const layout = parseLayout(first);
    if (layout === undefined) return undefined;
    const { paneCols: cols, paneRows: rows } = layout;
    if (cols < 1 || rows < 1) return undefined;
    const limit = clientLimit(layout, clients);
    return limit === undefined ? { cols, rows } : { cols, rows, clientLimit: limit };
  }

  // resize-window pins the window at a manual size that ignores attached
  // clients; unsetting the option hands the size back to tmux
  async unpinWindowSize(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-w', '-t', pane, '-u', 'window-size'])).code === 0;
  }

  async pastePrompt(socket: SocketRef, pane: string, buffer: string, prompt: string): Promise<boolean> {
    if (!paneId.test(pane) || !/^rac-[a-zA-Z0-9_-]+$/.test(buffer)) return false;
    const load = await run(this.binary, ['-S', socket.path, 'load-buffer', '-b', buffer, '-'], prompt);
    if (load.code !== 0) return false;
    return (await run(this.binary, ['-S', socket.path, 'paste-buffer', '-p', '-d', '-b', buffer, '-t', pane])).code === 0;
  }

  // submit the composed launch command into a reused idle shell (launch path)
  async enter(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'Enter'])).code === 0;
  }

  /**
   * Send an Adapter-composed key sequence one `send-keys` at a time (ADR 0002).
   * The keys are the Adapter's own words (submit, interrupt, option select); the
   * console performs the side effect. One invocation per key keeps a chord from
   * being read as Meta, and a key following `Escape` waits so the same does not
   * happen across the pair (Claude's interrupt is `Escape` then `C-c`).
   */
  async sendKeys(socket: SocketRef, pane: string, keys: readonly TmuxKey[]): Promise<boolean> {
    if (!paneId.test(pane) || keys.length === 0) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if ((await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, key])).code !== 0) return false;
      if (key === 'Escape' && index + 1 < keys.length) await delay(postEscapeDelayMs);
    }
    return true;
  }

  // write a console-owned Attention state on a pane (e.g. `finished` after an interrupt)
  async setReportedAttention(socket: SocketRef, pane: string, state: AttentionState): Promise<boolean> {
    if (!paneId.test(pane) || !attentionStates.has(state)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_attention', state])).code === 0;
  }

  // return the terminal to its shell before running a worktree operation
  async suspend(socket: SocketRef, pane: string): Promise<boolean> {
    // reject unsafe pane coordinates
    if (!paneId.test(pane)) return false;
    const metadata = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_pid}']);
    const pid = metadata.stdout.trim();
    // capture pane identity before sending the normal suspend shortcut
    if (metadata.code !== 0 || !/^\d+$/u.test(pid)) return false;
    // let the agent restore its own terminal state first
    if ((await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'C-z'])).code !== 0) return false;
    // keep the normal keyboard-driven suspend fast
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_current_command}']);
      // proceed only once a shell owns the terminal
      if (current.code === 0 && /^(?:ba|z|fi|da)?sh$/u.test(current.stdout.trim())) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const current = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_pid}']);
    // do not signal a pane that exited or was replaced while polling
    if (current.code !== 0 || current.stdout.trim() !== pid) return false;
    return await this.suspendForegroundJob(socket, pid);
  }

  // bypass ignored ctrl-z bytes while leaving failed suspension recoverable
  private async suspendForegroundJob(socket: SocketRef, pid: string): Promise<boolean> {
    return await this.runShell(socket, `
# inspect procfs in the tmux server namespace without optional system binaries
set -f
# parse fields after the final comm delimiter so spaces and parentheses remain safe
read_process() {
  IFS= read -r process_stat < "/proc/$1/stat" || return 1
  set -- \${process_stat##*) }
  # require the fields used for identity and job control
  [ "$#" -ge 20 ] || return 1
  process_state=$1
  process_group=$3
  process_session=$4
  process_foreground=$6
  process_started=\${20}
}
read_process ${pid} || exit 1
shell_group=$process_group
foreground=$process_foreground
shell_session=$process_session
# reject missing, invalid, and special process groups
case "$shell_group:$foreground:$shell_session" in *[!0-9:]*|:*|*::*|*:) exit 1;; esac
[ "$shell_group" -gt 1 ] && [ "$foreground" -gt 1 ] || exit 1
# constrain the foreground job to this terminal session
read_process "$foreground" || exit 1
[ "$process_group" = "$foreground" ] && [ "$process_session" = "$shell_session" ] || exit 1
job_started=$process_started
read_process ${pid} || exit 1
[ "$process_foreground" = "$foreground" ] || exit 1
# resume only the captured job if the shell cannot reclaim the terminal
trap 'kill -s CONT -- "-$foreground" 2>/dev/null || :' EXIT
# require a real interactive parent shell before stopping any job
IFS= read -r shell_command < /proc/${pid}/comm || exit 1
case "$shell_command" in sh|bash|dash|zsh|fish) ;; *) exit 1;; esac
# accept a shell that reclaimed the terminal after the initial poll
if [ "$foreground" = "$shell_group" ]; then trap - EXIT; exit 0; fi
kill -s TSTP -- "-$foreground" || exit 1
# bound the forced suspend independently of agent keyboard handling
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  read_process ${pid} || exit 1
  # retain suspension only after the original shell owns the terminal
  if [ "$process_foreground" = "$shell_group" ]; then
    read_process "$foreground" || exit 1
    # distinguish a stopped job from one that exited or was replaced
    [ "$process_group" = "$foreground" ] && [ "$process_session" = "$shell_session" ] && [ "$process_started" = "$job_started" ] || exit 1
    case "$process_state" in T|t) ;; *) exit 1;; esac
    trap - EXIT
    exit 0
  fi
  # stop waiting if another job took over this terminal
  [ "$process_foreground" = "$foreground" ] || exit 1
  sleep 0.05
done
exit 1
`);
  }

  async foreground(socket: SocketRef, pane: string): Promise<boolean> {
    // Clear any partial shell input before resuming the job suspended by
    // terminal mode. Use the normal pane input queue so `fg` cannot overtake
    // keystrokes already sent by the browser.
    return await this.input(socket, pane, '\x15fg\r');
  }

  async input(socket: SocketRef, pane: string, value: string): Promise<boolean> {
    if (!paneId.test(pane) || !value || value.length > 65_536 || value.includes('\0')) return false;
    const key = `${socket.path}\0${pane}`;
    const previous = this.inputQueues.get(key) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then((ready) => ready && this.sendInput(socket, pane, value));
    this.inputQueues.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this.inputQueues.get(key) === queued) this.inputQueues.delete(key);
    }
  }

  private async sendInput(socket: SocketRef, pane: string, value: string): Promise<boolean> {
    for (const part of value.split(/(\r\n|\r|\n|\x03)/u)) {
      if (!part) continue;
      const args = /^(?:\r\n|\r|\n)$/u.test(part)
        ? ['-S', socket.path, 'send-keys', '-t', pane, 'Enter']
        : part === '\x03'
          ? ['-S', socket.path, 'send-keys', '-t', pane, 'C-c']
          : ['-S', socket.path, 'send-keys', '-l', '-t', pane, part];
      if ((await run(this.binary, args)).code !== 0) return false;
    }
    return true;
  }

  async close(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'kill-pane', '-t', pane])).code === 0;
  }

  // run one shell command through the agent's tmux server, so under the host
  // bridge it executes on the host — the same side the agent's files live on.
  // tmux format-expands a run-shell argument before running it, so a `#(…)` in
  // the command would execute as a format substitution before `/bin/sh` ever
  // sees it. Double every `#` so tmux collapses it back to a literal `#` and the
  // command reaches the shell exactly as composed — the callers here compose a
  // plain shell command and never a tmux format (existing callers carry no `#`,
  // so this is a no-op for them), while a command built over an agent-controlled
  // path (a teardown's `cd -- '<workspace>'`) cannot smuggle a `#(…)` through.
  async runShell(socket: SocketRef, command: string): Promise<boolean> {
    if (!command || command.includes('\0')) return false;
    const literal = command.replaceAll('#', '##');
    return (await run(this.binary, ['-S', socket.path, 'run-shell', literal])).code === 0;
  }

  async terminateHostProcess(socket: SocketRef, pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    return await this.runShell(socket, `kill -TERM -- ${pid}`);
  }

  async closeSession(socket: SocketRef, session: string): Promise<boolean> {
    return sessionId.test(session) && (await run(this.binary, ['-S', socket.path, 'kill-session', '-t', session])).code === 0;
  }

  async attachArgs(socket: SocketRef, session: string): Promise<string[] | undefined> {
    return sessionId.test(session) ? ['-S', socket.path, 'attach-session', '-t', session] : undefined;
  }
}
