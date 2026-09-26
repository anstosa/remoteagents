import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { run, tmuxFormatLiteral } from './command.js';

type SessionCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const sessionId = /^\$\d+$/u;

// derive one stable display name
export function worktreeSessionName(path: string): string {
  return basename(path).replaceAll(':', '-');
}

// A session name free on a socket (`socketArgs` selects it, empty for the default one): the
// base name, else `-2`/`-3`/…, so a new session never collides with a same-named one (two
// Projects can share a checkout basename, and the default socket is the operator's own too).
// Falls back to a random suffix after a run of taken names.
export async function availableSessionName(binary: string, socketArgs: string[], base: string, command: SessionCommand = run): Promise<string> {
  const listed = await command(binary, [...socketArgs, 'list-sessions', '-F', '#{session_name}']);
  const taken = new Set(listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '') : []);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= 99; suffix += 1) { const candidate = `${base}-${suffix}`; if (!taken.has(candidate)) return candidate; }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

// Replace one colliding named session, returning the new session's pane id (undefined on
// failure). `name` is taken literally: tmux format-expands a session name, and one derived from
// a checkout path is agent-controlled, so it is escaped here; `tail` is the caller's to escape.
// Options on the new session target that pane id, never the name: tmux reads a dot
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
  const created = await command(binary, ['-S', socket, 'new-session', '-d', '-s', tmuxFormatLiteral(name), '-P', '-F', '#{pane_id}', ...tail]);
  if (created.code === 0) return created.stdout.trim();
  // restore the displaced session after a failed launch
  if (displacement !== undefined) await command(binary, ['-S', socket, 'rename-session', '-t', displacement.target, tmuxFormatLiteral(name)]);
  return undefined;
}
