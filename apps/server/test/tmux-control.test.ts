import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as mkdtempAsync, rm as rmAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SocketRef } from '../src/domain/models.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { PaneStreamRegistry, TmuxControlClient } from '../src/tmux/control.js';

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();

// The control client needs a real tmux server on a private unix socket. That runs on
// the host and in CI, but the build sandbox blocks unix sockets, so probe once and
// skip cleanly there rather than fail (the effort records the host run separately).
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-cc-probe-'));
    const socket = join(dir, 'sock');
    const started = spawnSync(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep 1'], { encoding: 'utf8' });
    spawnSync(tmux, ['-S', socket, 'kill-server']);
    return started.status === 0;
  } catch {
    return false;
  } finally {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
})();

const fixtures: Array<{ root: string; socket: string }> = [];

afterEach(async () => {
  for (const { root, socket } of fixtures.splice(0)) {
    await run(tmux, ['-S', socket, 'kill-server']).catch(() => undefined);
    await rmAsync(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// a fixture session with one pane running `cat`, whose tty echoes every typed byte as
// %output, so typing is observable both as pane activity and in a capture
async function fixtureSession(): Promise<{ ref: SocketRef; socket: string; pane: string }> {
  const root = await mkdtempAsync(join(tmpdir(), 'rac-control-'));
  const socket = join(root, 'tmux.sock');
  fixtures.push({ root, socket });
  expect((await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', 'cat'])).code).toBe(0);
  const paneOut = await run(tmux, ['-S', socket, 'display-message', '-p', '-t', 'fixture', '#{pane_id}']);
  const pane = paneOut.stdout.trim();
  expect(pane).toMatch(/^%\d+$/);
  return { ref: { path: socket, fingerprint: 'fixture', device: 0, inode: 0 }, socket, pane };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('control client did not reach the expected state');
}

describe.skipIf(!tmuxSocketsWork)('tmux control client (real tmux)', () => {
  // TmuxAdapter and PaneStreamRegistry resolve the binary from the env; on the host tmux
  // lives under mise, not /usr/bin/tmux, so point them at the probed binary
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('arms activity on %output and captures the pane on the same connection', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let activity = 0;
      client.subscribe(pane, { onActivity: () => { activity += 1; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });

      // typing into the pane echoes through the tty, producing %output
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'hello'])).code).toBe(0);
      await eventually(() => activity > 0);

      // the same connection can capture the pane; it shows the echoed text
      const captured = await client.capture(pane, 100);
      expect(captured).toContain('hello');

      // an idle pane produces no further activity
      const settled = activity;
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(activity).toBe(settled);
    } finally {
      client.dispose();
    }
  });

  it('reconstructs the same bytes a spawned capture-pane produces', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let ready = false;
      // subscribe before typing so the echo's %output is not missed
      client.subscribe(pane, { onActivity: () => { ready = true; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'café ☕'])).code).toBe(0);
      await eventually(() => ready);

      const overControl = await client.capture(pane, 100);
      const spawned = await run(tmux, ['-S', socket, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-100']);
      // the control path must reproduce the spawned stdout byte-for-byte, trailing
      // newline included, so the shared line-slicing/bottom-alignment behaves identically
      expect(overControl).toBe(spawned.stdout);
      expect(overControl).toContain('café ☕');
    } finally {
      client.dispose();
    }
  });

  it('shares one client per session and reaps it when the last viewer leaves', async () => {
    const { ref, pane } = await fixtureSession();
    const registry = new PaneStreamRegistry();
    try {
      const first = registry.get(ref, 'fixture');
      const second = registry.get(ref, 'fixture');
      expect(second).toBe(first);
      expect(registry.size).toBe(1);

      const unsubscribeA = first.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      const unsubscribeB = second.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: () => {} });

      unsubscribeA();
      expect(registry.size).toBe(1);

      unsubscribeB();
      expect(registry.size).toBe(0);
      // a later viewer of the same session gets a fresh client
      const reopened = registry.get(ref, 'fixture');
      expect(reopened).not.toBe(first);
      expect(registry.size).toBe(1);
    } finally {
      registry.closeAll();
    }
  });

  it('attaches as a control-mode client that does not clamp the pane size', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      // tmux flags our attach as control-mode; the adapter's client-limit read keys off
      // exactly that flag string
      const clients = await run(tmux, ['-S', socket, 'list-clients', '-t', pane, '-F', '#{client_flags}']);
      expect(clients.stdout).toContain('control-mode');

      // with only the control client attached, the pane keeps its own size (80x24 here)
      // rather than being clamped to a phantom viewport
      const geometry = await new TmuxAdapter().size(ref, pane);
      expect(geometry).toEqual({ cols: 80, rows: 24 });
    } finally {
      client.dispose();
    }
  });

  it('reads the id of the window holding a pane, so the Size claim is keyed by window', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      const expected = (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{window_id}'])).stdout.trim();
      expect(expected).toMatch(/^@\d+$/);
      expect(await client.windowId(pane)).toBe(expected);
    } finally {
      client.dispose();
    }
  });

  it('re-clamps on an external window resize (%layout-change)', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      // an external resize-window (as a zoom or an operator's resize does) emits %layout-change
      // to our control client, which re-asserts the Size claim
      expect((await run(tmux, ['-S', socket, 'resize-window', '-t', pane, '-x', '100', '-y', '30'])).code).toBe(0);
      await eventually(() => resizes > 0);
    } finally {
      client.dispose();
    }
  });

  it('re-asserts the Size claim when a pane is zoomed from an attached terminal', async () => {
    const { ref, socket, pane } = await fixtureSession();
    // a second pane so the window can be zoomed; zoom and unzoom both emit %layout-change
    expect((await run(tmux, ['-S', socket, 'split-window', '-t', pane, '-d', 'cat'])).code).toBe(0);
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'resize-pane', '-Z', '-t', pane])).code).toBe(0);
      await eventually(() => resizes > 0);
    } finally {
      client.dispose();
    }
  });

  it('re-clamps when an attached client resizes (the -B client-size subscription)', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    // A second control client, `-f ignore-size` so it never affects window-size and so emits
    // no %layout-change: every onResize below therefore comes from the client-size
    // subscription (%subscription-changed), isolating the -B path from the layout path.
    const second = spawn(tmux, ['-S', socket, '-C', 'attach-session', '-t', 'fixture', '-f', 'ignore-size']);
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      // let the subscription arm and the attach's own change settle, then drive one pure
      // client-size change; tmux pushes it through %subscription-changed at most once a second
      await new Promise(resolve => setTimeout(resolve, 1_100));
      resizes = 0;
      second.stdin?.write('refresh-client -C 200x60\n');
      await eventually(() => resizes > 0);
    } finally {
      second.stdin?.write('detach\n');
      second.kill('SIGTERM');
      client.dispose();
    }
  });

  it('ends subscribers when the tmux server goes away', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let exited = false;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: () => { exited = true; } });
      await run(tmux, ['-S', socket, 'kill-server']);
      await eventually(() => exited);
    } finally {
      client.dispose();
    }
  });
});
