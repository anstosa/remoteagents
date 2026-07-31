import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { run } from './command.js';

type SessionCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export function worktreeSessionName(path: string): string {
  return basename(path).replaceAll(':', '-');
}

export async function startNamedReplacementSession(binary: string, socket: string, currentSession: string, name: string, tail: string[], command: SessionCommand = run): Promise<boolean> {
  const currentName = await command(binary, ['-S', socket, 'display-message', '-p', '-t', currentSession, '#{session_name}']);
  const temporaryName = currentName.code === 0 && currentName.stdout.trim() === name ? `rac-replacing-${randomBytes(6).toString('hex')}` : undefined;
  if (temporaryName !== undefined && (await command(binary, ['-S', socket, 'rename-session', '-t', currentSession, temporaryName])).code !== 0) return false;
  if ((await command(binary, ['-S', socket, 'new-session', '-d', '-s', name, ...tail])).code === 0) return true;
  if (temporaryName !== undefined) await command(binary, ['-S', socket, 'rename-session', '-t', temporaryName, name]);
  return false;
}
