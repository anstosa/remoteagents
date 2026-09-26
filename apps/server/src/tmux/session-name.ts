import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { run } from './command.js';

type SessionCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const sessionId = /^\$\d+$/u;

// derive one stable display name
export function worktreeSessionName(path: string): string {
  return basename(path).replaceAll(':', '-');
}

// Replace one colliding named session, returning the new session's pane id (undefined on
// failure). Options on the new session target that pane id, never the name: tmux reads a dot
// in a bare name as a pane separator, so `-p -t ferry.fyi` finds no pane.
export async function startNamedReplacementSession(binary: string, socket: string, currentSession: string, name: string, tail: string[], command: SessionCommand = run): Promise<string | undefined> {
  // fully qualify names before tmux parses dotted targets
  const currentTarget = sessionId.test(currentSession) ? currentSession : `=${currentSession}:`;
  const currentId = await command(binary, ['-S', socket, 'display-message', '-p', '-t', currentTarget, '#{session_id}']);
  const stableTarget = currentId.code === 0 && sessionId.test(currentId.stdout.trim()) ? currentId.stdout.trim() : undefined;
  const currentName = stableTarget === undefined ? undefined : await command(binary, ['-S', socket, 'display-message', '-p', '-t', stableTarget, '#{session_name}']);
  const displacement = stableTarget !== undefined && currentName?.code === 0 && currentName.stdout.trim() === name
    ? { target: stableTarget, temporaryName: `rac-replacing-${randomBytes(6).toString('hex')}` }
    : undefined;
  // avoid tmux parsing dots as pane separators
  if (displacement !== undefined && (await command(binary, ['-S', socket, 'rename-session', '-t', displacement.target, displacement.temporaryName])).code !== 0) return undefined;
  const created = await command(binary, ['-S', socket, 'new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', ...tail]);
  if (created.code === 0) return created.stdout.trim();
  // restore the displaced session after a failed launch
  if (displacement !== undefined) await command(binary, ['-S', socket, 'rename-session', '-t', displacement.target, name]);
  return undefined;
}
