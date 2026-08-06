import type { Pane, SocketRef } from '../domain/models.js';
import { run } from './command.js';

const paneId = /^%\d+$/;
const sessionId = /^\$?[-\w.]+$/;

/**
 * `capture-pane -e` preserves the SGR codes tmux uses for its rendered
 * snapshot.  Keep those color/style codes, but discard every other terminal
 * control sequence: Codex can emit alternate-screen and OSC controls while a
 * completion menu is open, and replaying those in the browser xterm changes
 * its terminal state instead of just rendering the snapshot.
 */
export function lastPromptFromHistory(value: string): string | undefined {
  const lines = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/u.exec(lines[index]!);
    if (!match) continue;
    const prompt = [match[1]];
    let continuation = index + 1;
    while (continuation < lines.length && /^ {2}\S/u.test(lines[continuation]!)) prompt.push(lines[continuation++]!.trim());
    while (continuation < lines.length && lines[continuation] === '') continuation += 1;
    if (/^•\s/u.test(lines[continuation] ?? '')) return prompt.join(' ');
  }
  return undefined;
}

const assistantMarkdown = (value: string) => {
  const withoutOsc = value.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '');
  const sgr = /\x1b\[([0-9;]*)m/gu;
  let markdown = '';
  let cursor = 0;
  let codeColor = false;
  let underlined = false;
  let codeOpen = false;
  const syncCode = () => {
    const next = codeColor && !underlined;
    if (next !== codeOpen) markdown += '`';
    codeOpen = next;
  };
  for (const match of withoutOsc.matchAll(sgr)) {
    markdown += withoutOsc.slice(cursor, match.index);
    const parameters = (match[1] || '0').split(';').map(Number);
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      if (parameter === 0) { codeColor = false; underlined = false; }
      else if (parameter === 4) underlined = true;
      else if (parameter === 24) underlined = false;
      else if (parameter === 39) codeColor = false;
      else if (parameter === 36) codeColor = true;
      else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) codeColor = false;
      else if (parameter === 38 && parameters[index + 1] === 5 && parameters[index + 2] !== undefined) {
        codeColor = parameters[index + 2] === 6;
        index += 2;
      } else if (parameter === 38 && parameters[index + 1] === 2 && parameters[index + 4] !== undefined) {
        codeColor = false;
        index += 4;
      }
    }
    syncCode();
    cursor = (match.index ?? 0) + match[0].length;
  }
  markdown += withoutOsc.slice(cursor);
  if (codeOpen) markdown += '`';
  return markdown.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '');
};

export function latestCompletedAssistantMessage(value: string): { text: string; rows: number } | undefined {
  const lines = assistantMarkdown(value).split('\n');
  let completedAt = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^─ Worked for\b/u.test(lines[index]!)) { completedAt = index; break; }
  }
  if (completedAt < 0) return undefined;

  // A submitted prompt after this completion means a newer response is in
  // progress. Keep the previous completion from being offered as "latest".
  for (let index = completedAt + 1; index < lines.length; index += 1) {
    if (!/^›\s+\S/u.test(lines[index]!)) continue;
    let following = index + 1;
    while (following < lines.length && /^ {2}\S/u.test(lines[following]!)) following += 1;
    while (following < lines.length && lines[following] === '') following += 1;
    if (/^•(?:\s|$)/u.test(lines[following] ?? '')) return undefined;
  }

  let start = completedAt - 1;
  while (start >= 0 && !/^•(?:\s|$)/u.test(lines[start]!)) start -= 1;
  if (start < 0) return undefined;
  let contentEnd = completedAt;
  while (contentEnd > start && !lines[contentEnd - 1]!.trim()) contentEnd -= 1;
  const rendered = lines.slice(start, contentEnd);
  rendered[0] = rendered[0]!.replace(/^•\s?/u, '');
  for (let index = 1; index < rendered.length; index += 1) rendered[index] = rendered[index]!.replace(/^ {2}/u, '');
  const text = rendered.join('\n').trim();
  return text ? { text, rows: contentEnd - start } : undefined;
}

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

export class TmuxAdapter {
  private readonly binary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  private readonly inputQueues = new Map<string, Promise<boolean>>();

  async listPanes(socket: SocketRef): Promise<Pane[]> {
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}']);
    if (out.code !== 0) return [];
    return out.stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
      const [id, session, name, pid, path, command, title, displayLabel, startCommand] = line.split('\t');
      return paneId.test(id) && sessionId.test(session) && name && /^\d+$/.test(pid) && path ? [{ paneId: id, sessionId: session, sessionName: name, pid: Number(pid), path, command: command ?? '', title: title ?? '', ...(displayLabel ? { displayLabel } : {}), ...(startCommand ? { startCommand } : {}), socket }] : [];
    });
  }

  async capture(socket: SocketRef, pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-800']);
    return out.code === 0 ? safeSnapshot(out.stdout).slice(-96_000) : undefined;
  }

  async captureWindow(socket: SocketRef, pane: string, history: number, rows: number): Promise<{ text: string; older: boolean; lastPrompt?: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean } | undefined> {
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
    const assistantMessage = latestCompletedAssistantMessage(out.stdout);
    const latestAssistantMessage = assistantMessage !== undefined && assistantMessage.text.length <= 30_000 ? assistantMessage.text : undefined;
    const latestAssistantMessageOverflows = assistantMessage === undefined || latestAssistantMessage === undefined ? undefined : assistantMessage.rows > rows;
    const window = bottomAlignedWindow(lines.slice(start, end), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0, ...(lastPrompt === undefined ? {} : { lastPrompt }), ...(latestAssistantMessage === undefined ? {} : { latestAssistantMessage, latestAssistantMessageOverflows }) };
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

  async enter(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'Enter'])).code === 0;
  }

  async queue(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'Tab'])).code === 0;
  }

  async dismissCompletion(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'Escape'])).code === 0;
  }

  async selectOption(socket: SocketRef, pane: string, index: number): Promise<boolean> {
    if (!paneId.test(pane) || !Number.isInteger(index) || index < 0 || index > 15) return false;
    // Codex presents the first choice as selected. `Home` is handled by its
    // editor rather than its confirmation list, so only move down from that
    // default selection before confirming.
    const keys = [...Array.from({ length: index }, () => 'Down'), 'Enter'];
    return (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, ...keys])).code === 0;
  }

  async interrupt(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'C-c'])).code === 0;
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

  async quitReview(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    const current = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, '#{pane_current_command}']);
    if (current.code !== 0) return false;
    // The review command resumes the suspended agent after Neovim exits. If
    // the user already quit Neovim directly, do not type a quit command into
    // the resumed agent.
    if (!/^(?:n?vim|view)$/u.test(current.stdout.trim())) return true;
    return await this.input(socket, pane, '\x1b:qa!\r');
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

  async terminateHostProcess(socket: SocketRef, pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    return (await run(this.binary, ['-S', socket.path, 'run-shell', `kill -TERM -- ${pid}`])).code === 0;
  }

  async closeSession(socket: SocketRef, session: string): Promise<boolean> {
    return sessionId.test(session) && (await run(this.binary, ['-S', socket.path, 'kill-session', '-t', session])).code === 0;
  }

  async attachArgs(socket: SocketRef, session: string): Promise<string[] | undefined> {
    return sessionId.test(session) ? ['-S', socket.path, 'attach-session', '-t', session] : undefined;
  }
}
