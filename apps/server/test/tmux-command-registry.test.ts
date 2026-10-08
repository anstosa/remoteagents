import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketRef } from '../src/domain/models.js';

const { clients, createClient } = vi.hoisted(() => {
  const clients: Array<{ ready: Promise<void>; command: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  // record connection lifetime without starting tmux
  const createClient = vi.fn(function (_binary, _path, _session, onGone) {
    const client = { ready: Promise.resolve(), command: vi.fn().mockResolvedValue({ ok: true, lines: ['pane'] }), dispose: vi.fn(() => onGone()) };
    clients.push(client);
    return client;
  });
  return { clients, createClient };
});
vi.mock('../src/tmux/control.js', () => ({ TmuxControlClient: createClient }));
vi.mock('../src/tmux/command.js', async original => ({ ...await original<typeof import('../src/tmux/command.js')>(), socketIsCurrent: vi.fn().mockResolvedValue(true) }));
import { socketIsCurrent } from '../src/tmux/command.js';
import { TmuxCommandRegistry } from '../src/tmux/command-registry.js';
const socket: SocketRef = { path: '/tmp/tmux-test', fingerprint: 'one', device: 1, inode: 2 };

// capture degraded-transport diagnostics without cluttering test output
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// reset isolated connection fixtures
afterEach(() => { clients.length = 0; vi.mocked(console.warn).mockRestore(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('dashboard tmux command connections', () => {
  // the dashboard needs no browser lease
  it('reuses a command-only connection and preserves unicode replies', async () => {
    const registry = new TmuxCommandRegistry();
    await registry.listPanes(socket, '#{pane_id}\t#{pane_title}');
    clients[0]!.command.mockResolvedValue({ ok: true, lines: [Buffer.from('café ☕').toString('latin1')] });
    expect(await registry.listPanes(socket, '#{pane_id}\t#{pane_title}')).toBe('café ☕\n');
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0]?.[2]).toBeUndefined();
    expect(createClient.mock.calls[0]?.[4]).toMatchObject({ commandOnly: true, timeoutMs: 2_000 });
    registry.closeAll();
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  // attach is shared while concurrent readers wait
  it('creates only one connection for concurrent listings', async () => {
    const registry = new TmuxCommandRegistry();
    await Promise.all([registry.listPanes(socket, '#{pane_id}'), registry.listPanes(socket, '#{pane_id}')]);
    expect(createClient).toHaveBeenCalledTimes(1);
    registry.closeAll();
  });

  // failed reads leave the caller free to use the spawned fallback
  it.each(['reject', 'error'] as const)('backs off after a %s reply and reconnects later', async failure => {
    vi.useFakeTimers();
    const registry = new TmuxCommandRegistry();
    await registry.listPanes(socket, '#{pane_id}');
    // exercise both transport loss and tmux command failure
    if (failure === 'reject') clients[0]!.command.mockRejectedValue(new Error('lost'));
    else clients[0]!.command.mockResolvedValue({ ok: false, lines: ['failed'] });
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await registry.listPanes(socket, '#{pane_id}')).toBe('pane\n');
    expect(createClient).toHaveBeenCalledTimes(2);
    registry.closeAll();
  });

  // a replacement socket must not inherit the old connection or its backoff
  it('replaces changed socket identities and releases undiscovered sockets', async () => {
    const registry = new TmuxCommandRegistry();
    await registry.listPanes(socket, '#{pane_id}');
    const replacement = { ...socket, fingerprint: 'two', inode: 3 };
    await registry.listPanes(replacement, '#{pane_id}');
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients[0]!.dispose).toHaveBeenCalledOnce();
    registry.retainSockets([replacement]);
    expect(clients[1]!.dispose).not.toHaveBeenCalled();
    registry.retainSockets([]);
    expect(clients[1]!.dispose).toHaveBeenCalledOnce();
    registry.closeAll();
    expect(console.warn).not.toHaveBeenCalled();
  });

  // overlapping failures and failed reconnects share one diagnostic until recovery
  it('reports attach failures once while preserving fallback and retry', async () => {
    vi.useFakeTimers();
    const create = createClient.getMockImplementation()!;
    // fail two consecutive connections before allowing recovery
    const rejectAttach = function (...args: Parameters<typeof create>) {
      const client = create(...args);
      client.ready = Promise.reject(new Error('attach denied'));
      return client;
    };
    createClient.mockImplementationOnce(rejectAttach).mockImplementationOnce(rejectAttach);
    const registry = new TmuxCommandRegistry();
    expect(await Promise.all([registry.listPanes(socket, '#{pane_id}'), registry.listPanes(socket, '#{pane_id}')])).toEqual([undefined, undefined]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ socket: socket.path, stage: 'attach', error: 'attach denied' }));
    await registry.listPanes(socket, '#{pane_id}');
    expect(console.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await registry.listPanes(socket, '#{pane_id}');
    clients[2]!.command.mockResolvedValue({ ok: false, lines: ['failed'] });
    await registry.listPanes(socket, '#{pane_id}');
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ stage: 'list-panes' }));
    registry.closeAll();
  });

  // an idle primary connection can fail between dashboard polls
  it('reports unexpected connection loss even with no command pending', async () => {
    const registry = new TmuxCommandRegistry();
    await registry.listPanes(socket, '#{pane_id}');
    createClient.mock.calls[0]![3]();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ socket: socket.path, stage: 'connection' }));
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    registry.closeAll();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  // stale discovery references never attach a replacement server
  it('rejects a replaced socket before opening a client', async () => {
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(false);
    const registry = new TmuxCommandRegistry();
    expect(await registry.listPanes(socket, '#{pane_id}')).toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
    registry.closeAll();
  });

  // stale callbacks cannot evict a replacement
  it('keeps the new connection when an old one exits late', async () => {
    const registry = new TmuxCommandRegistry();
    await registry.listPanes(socket, '#{pane_id}');
    const replacement = { ...socket, fingerprint: 'two', inode: 3 };
    await registry.listPanes(replacement, '#{pane_id}');
    createClient.mock.calls[0]![3]();
    await registry.listPanes(replacement, '#{pane_id}');
    expect(createClient).toHaveBeenCalledTimes(2);
    registry.closeAll();
  });
});
