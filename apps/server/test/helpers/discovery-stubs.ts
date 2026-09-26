import type { Pane, SocketRef } from '../../src/domain/models.js';
import type { AgentKind } from '../../src/adapters/types.js';
import type { SocketFinder } from '../../src/discovery/service.js';
import type { ProcessInspector } from '../../src/discovery/processes.js';

/** The socket every DiscoveryService/LaunchService test uses. */
export const testSocket: SocketRef = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

/** A SocketFinder over a fixed set of sockets (defaults to {@link testSocket}). */
export const socketFinder = (sockets: SocketRef[] = [testSocket]): SocketFinder => ({ find: async () => sockets });

/**
 * A stub tmux over a fixed pane list — `listPanes`, plus `markSessionPlace`, whose
 * session marks later listings report on every pane of the session, as tmux does.
 * That is all DiscoveryService refresh/dashboard exercises. Cast the result `as never`
 * where a full `TmuxAdapter` is expected.
 */
export const paneLister = (panes: Partial<Pane>[]) => {
  const marks = new Map<string, string>();
  return {
    marks,
    listPanes: async (): Promise<Partial<Pane>[]> => panes.map(pane => { const placeMark = marks.get(pane.sessionId ?? ''); return placeMark === undefined ? pane : { ...pane, placeMark }; }),
    markSessionPlace: async (_socket: SocketRef, session: string, placeId: string): Promise<boolean> => { marks.set(session, placeId); return true; }
  };
};

/**
 * A ProcessInspector: `codex` (default true) controls whether the walker
 * recognizes an agent under the pane; `kind` picks the recognized kind.
 */
export const processInspector = (options: { codex?: boolean; kind?: AgentKind } = {}): ProcessInspector => ({
  recognizeAgent: async (pid: number) => (options.codex ?? true) ? { kind: options.kind ?? 'codex', pid, wrapped: false } : undefined,
});
