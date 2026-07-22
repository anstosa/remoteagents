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

export class TmuxAdapter {
  private readonly binary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';

  async listPanes(socket: SocketRef): Promise<Pane[]> {
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}']);
    if (out.code !== 0) return [];
    return out.stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
      const [id, session, pid, path, command, title] = line.split('\t');
      return paneId.test(id) && sessionId.test(session) && /^\d+$/.test(pid) && path ? [{ paneId: id, sessionId: session, pid: Number(pid), path, command: command ?? '', title: title ?? '', socket }] : [];
    });
  }

  async capture(socket: SocketRef, pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-800']);
    return out.code === 0 ? safeSnapshot(out.stdout).slice(-96_000) : undefined;
  }

  async captureWindow(socket: SocketRef, pane: string, history: number, rows: number): Promise<{ text: string; older: boolean } | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(history) || history < 0 || history > 5_000 || !Number.isInteger(rows) || rows < 2 || rows > 300) return undefined;
    const window = rows;
    // tmux's native capture is the source of truth for the live page. In
    // particular, do not approximate it with -S/-E coordinates: those can
    // omit a bottom row after a resize or wrapped terminal line.
    if (history === 0) {
      const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane]);
      return out.code === 0 ? { text: safeSnapshot(out.stdout), older: false } : undefined;
    }
    // tmux's -S/-E values are coordinates relative to the visible pane, not
    // a request for the last N lines. Capture the target viewport plus one
    // preceding page and take its tail; subtracting `history` again here
    // moves each click progressively farther than one page.
    const start = -Math.min(5_000, history + window);
    const end = -history + window - 1;
    const out = await run(this.binary, ['-S', socket.path, 'capture-pane', '-e', '-p', '-t', pane, '-S', String(start), '-E', String(end)]);
    if (out.code !== 0) return undefined;
    const lines = out.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const visibleStart = Math.max(0, lines.length - window);
    const visible = lines.slice(visibleStart).join('\n');
    return { text: safeSnapshot(visible), older: visibleStart > 0 };
  }

  async resize(socket: SocketRef, pane: string, cols: number, rows: number): Promise<boolean> {
    if (!paneId.test(pane) || !Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 300) return false;
    return (await run(this.binary, ['-S', socket.path, 'resize-pane', '-t', pane, '-x', String(cols), '-y', String(rows)])).code === 0;
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

  async input(socket: SocketRef, pane: string, value: string): Promise<boolean> {
    if (!paneId.test(pane) || !value || value.length > 65_536 || value.includes('\0')) return false;
    return (await run(this.binary, ['-S', socket.path, 'send-keys', '-l', '-t', pane, value])).code === 0;
  }

  async close(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'kill-pane', '-t', pane])).code === 0;
  }

  async attachArgs(socket: SocketRef, session: string): Promise<string[] | undefined> {
    return sessionId.test(session) ? ['-S', socket.path, 'attach-session', '-t', session] : undefined;
  }
}
