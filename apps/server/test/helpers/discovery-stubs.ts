import type { CodexSessionRef, Pane, SocketRef } from '../../src/domain/models.js';
import type { AgentKind } from '../../src/adapters/types.js';
import type { SocketFinder } from '../../src/discovery/service.js';
import type { ProcessInspector } from '../../src/discovery/processes.js';

/** The socket every DiscoveryService/LaunchService test uses. */
export const testSocket: SocketRef = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

/** A SocketFinder over a fixed set of sockets (defaults to {@link testSocket}). */
export const socketFinder = (sockets: SocketRef[] = [testSocket]): SocketFinder => ({ find: async () => sockets });

/**
 * A stub tmux over a fixed pane list — only `listPanes` is implemented, which is
 * all DiscoveryService refresh/dashboard exercises. Cast the result `as never`
 * where a full `TmuxAdapter` is expected.
 */
export const paneLister = (panes: Partial<Pane>[]): { listPanes: () => Promise<Partial<Pane>[]> } => ({ listPanes: async () => panes });

/**
 * A ProcessInspector: `codex` (default true) controls whether the walker
 * recognizes an agent under the pane; `kind` picks the recognized kind; provide
 * `sessions` to enumerate rollout sessions per pid.
 */
export const processInspector = (options: { codex?: boolean; kind?: AgentKind; sessions?: (pid: number) => CodexSessionRef[] } = {}): ProcessInspector => ({
  recognizeAgent: async (pid: number) => (options.codex ?? true) ? { kind: options.kind ?? 'codex', pid, wrapped: false } : undefined,
  ...(options.sessions ? { sessionsForDescendants: async (pid: number) => options.sessions!(pid) } : {}),
});
