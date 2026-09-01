import type { Pane, SocketRef } from '../domain/models.js';
import { lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantMessage } from '../adapters/codex-turns.js';
import type { AttentionState, TmuxKey } from '../adapters/types.js';
import { run } from './command.js';

const paneId = /^%\d+$/;
const sessionId = /^\$?[-\w.]+$/;
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

export class TmuxAdapter {
  private readonly binary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly inputQueues = new Map<string, Promise<boolean>>();

  async listPanes(socket: SocketRef): Promise<Pane[]> {
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}\t#{@rac_attention}\t#{@rac_session}\t#{@rac_sandboxed}']);
    if (out.code !== 0) return [];
    return out.stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
      const [id, session, name, pid, path, command, title, displayLabel, startCommand, attention, sessionRef, sandboxed] = line.split('\t');
      return paneId.test(id) && sessionId.test(session) && name && /^\d+$/.test(pid) && path ? [{ paneId: id, sessionId: session, sessionName: name, pid: Number(pid), path, command: command ?? '', title: title ?? '', ...(displayLabel ? { displayLabel } : {}), ...(startCommand ? { startCommand } : {}), ...(attention ? { reportedAttention: attention } : {}), ...(sessionRef ? { reportedSession: sessionRef } : {}), ...(sandboxed ? { reportedSandboxed: sandboxed } : {}), socket }] : [];
    });
  }

  // clear the console-owned reported-state options once a pane's agent is gone
  async unsetReportedState(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    const results = await Promise.all(['@rac_attention', '@rac_session', '@rac_sandboxed'].map(
      option => run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', option])
    ));
    return results.every(result => result.code === 0);
  }

  // assign one server-owned pane label
  async label(socket: SocketRef, pane: string, label: string): Promise<boolean> {
    // reject unsafe pane coordinates and control characters
    if (!paneId.test(pane) || label.length === 0 || label.length > 120 || /[\0\r\n]/u.test(label)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_display_label', label])).code === 0;
  }

  async capture(socket: SocketRef, pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-800']);
    return out.code === 0 ? safeSnapshot(out.stdout).slice(-96_000) : undefined;
  }

  // capture only the current browser window
  async captureRecentWindow(socket: SocketRef, pane: string, rows: number): Promise<CapturedWindow | undefined> {
    // reject unsafe pane coordinates
    if (!paneId.test(pane) || !Number.isInteger(rows) || rows < 2 || rows > 300) return undefined;
    const depth = Math.min(300, rows + 24);
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', `-${depth}`]);
    // reject failed captures
    if (out.code !== 0) return undefined;
    const lines = out.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const start = Math.max(0, lines.length - rows);
    const window = bottomAlignedWindow(lines.slice(start), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0 };
  }

  async captureWindow(socket: SocketRef, pane: string, history: number, rows: number): Promise<CapturedWindow | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(history) || history < 0 || history > 5_000 || !Number.isInteger(rows) || rows < 2 || rows > 300) return undefined;
    // tmux's -S/-E coordinates shift around wrapped and blank rows. Capture a
    // bounded history snapshot and slice its concrete lines instead, so page
    // offsets are stable and adjacent windows overlap exactly as requested.
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-5000']);
    if (out.code !== 0) return undefined;
    const lines = out.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const maximumOffset = Math.max(0, lines.length - rows);
    const offset = Math.min(history, maximumOffset);
    const end = lines.length - offset;
    const start = Math.max(0, end - rows);
    const lastPrompt = lastPromptFromHistory(out.stdout);
    const latestAgentMessage = latestAgentMessageFromHistory(out.stdout);
    const assistantMessage = latestCompletedAssistantMessage(out.stdout);
    const latestAssistantMessage = assistantMessage !== undefined && assistantMessage.text.length <= 30_000 ? assistantMessage.text : undefined;
    const latestAssistantMessageOverflows = assistantMessage === undefined || latestAssistantMessage === undefined ? undefined : assistantMessage.rows > rows;
    const window = bottomAlignedWindow(lines.slice(start, end), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0, ...(lastPrompt === undefined ? {} : { lastPrompt }), ...(latestAgentMessage === undefined ? {} : { latestAgentMessage }), ...(latestAssistantMessage === undefined ? {} : { latestAssistantMessage, latestAssistantMessageOverflows }) };
  }

  async resize(socket: SocketRef, pane: string, cols: number, rows: number): Promise<boolean> {
    if (!paneId.test(pane) || !Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 300) return false;
    const readLayout = async () => {
      const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}']);
      const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)$/u.exec(out.stdout.trim());
      if (out.code !== 0 || match === null) return undefined;
      return { windowCols: Number(match[1]), windowRows: Number(match[2]), paneCols: Number(match[3]), paneRows: Number(match[4]) };
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

  async size(socket: SocketRef, pane: string): Promise<{ cols: number; rows: number } | undefined> {
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_width}\t#{pane_height}']);
    const match = /^(\d+)\t(\d+)$/u.exec(out.stdout.trim());
    if (out.code !== 0 || match === null) return undefined;
    const cols = Number(match[1]);
    const rows = Number(match[2]);
    return cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300 ? { cols, rows } : undefined;
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

  async suspend(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    const metadata = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_pid}']);
    const pid = metadata.stdout.trim();
    if (metadata.code !== 0 || !/^\d+$/u.test(pid)) return false;
    if ((await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'C-z'])).code !== 0) return false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_current_command}']);
      if (current.code === 0 && /^(?:ba|z|fi|da)?sh$/u.test(current.stdout.trim())) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const resume = `tpgid="$(ps -o tpgid= -p ${pid} | tr -d ' ')" && case "$tpgid" in ''|*[!0-9]*) exit 1;; esac && kill -CONT -- "-$tpgid"`;
    await run(this.binary, ['-S', socket.path, 'run-shell', resume]);
    return false;
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
