import type { Pane, SocketRef } from '../domain/models.js';
import { run } from './command.js';
const paneId = /^%\d+$/; const sessionId = /^\$?[-\w.]+$/;
export class TmuxAdapter {
  async listPanes(socket: SocketRef): Promise<Pane[]> { const out = await run('/usr/bin/tmux', ['-S', socket.path, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_title}']); if (out.code !== 0) return []; return out.stdout.trim().split('\n').filter(Boolean).flatMap((line) => { const [id, session, pid, path, title] = line.split('\t'); return paneId.test(id) && sessionId.test(session) && /^\d+$/.test(pid) && path ? [{ paneId: id, sessionId: session, pid: Number(pid), path, title: title ?? '', socket }] : []; }); }
  async capture(socket: SocketRef, pane: string): Promise<string | undefined> { if (!paneId.test(pane)) return undefined; const out = await run('/usr/bin/tmux', ['-S', socket.path, 'capture-pane', '-p', '-t', pane, '-S', '-5000']); return out.code === 0 ? out.stdout.slice(-256_000) : undefined; }
  async pastePrompt(socket: SocketRef, pane: string, buffer: string, prompt: string): Promise<boolean> { if (!paneId.test(pane) || !/^rac-[a-zA-Z0-9_-]+$/.test(buffer)) return false; const load = await run('/usr/bin/tmux', ['-S', socket.path, 'load-buffer', '-b', buffer, '-'], prompt); if (load.code !== 0) return false; const pasted = await run('/usr/bin/tmux', ['-S', socket.path, 'paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]); return pasted.code === 0; }
  async enter(socket: SocketRef, pane: string): Promise<boolean> { if (!paneId.test(pane)) return false; return (await run('/usr/bin/tmux', ['-S', socket.path, 'send-keys', '-t', pane, 'Enter'])).code === 0; }
  async attachArgs(socket: SocketRef, session: string): Promise<string[] | undefined> { if (!sessionId.test(session)) return undefined; return ['-S', socket.path, 'attach-session', '-t', session]; }
}
