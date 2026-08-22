import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { run } from './command.js';

type SessionCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const sessionId = /^\$\d+$/u;

// derive one stable display name
export function worktreeSessionName(path: string): string {
  return basename(path).replaceAll(':', '-');
}

// replace one colliding named session
export async function startNamedReplacementSession(binary: string, socket: string, currentSession: string, name: string, tail: string[], command: SessionCommand = run): Promise<boolean> {
  // fully qualify names before tmux parses dotted targets
  const currentTarget = sessionId.test(currentSession) ? currentSession : `=${currentSession}:`;
  const currentId = await command(binary, ['-S', socket, 'display-message', '-p', '-t', currentTarget, '#{session_id}']);
  const stableTarget = currentId.code === 0 && sessionId.test(currentId.stdout.trim()) ? currentId.stdout.trim() : undefined;
  const currentName = stableTarget === undefined ? undefined : await command(binary, ['-S', socket, 'display-message', '-p', '-t', stableTarget, '#{session_name}']);
  const displacement = stableTarget !== undefined && currentName?.code === 0 && currentName.stdout.trim() === name
    ? { target: stableTarget, temporaryName: `rac-replacing-${randomBytes(6).toString('hex')}` }
    : undefined;
  // avoid tmux parsing dots as pane separators
  if (displacement !== undefined && (await command(binary, ['-S', socket, 'rename-session', '-t', displacement.target, displacement.temporaryName])).code !== 0) return false;
  if ((await command(binary, ['-S', socket, 'new-session', '-d', '-s', name, ...tail])).code === 0) return true;
  // restore the displaced session after a failed launch
  if (displacement !== undefined) await command(binary, ['-S', socket, 'rename-session', '-t', displacement.target, name]);
  return false;
}
