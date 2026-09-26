import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { run } from '../src/tmux/command.js';
import { testConfig, testWorktree } from './helpers/config.js';

// Stack processes against a throwaway tmux server on a private socket: a real long-running
// command stays live in its tagged window, a fresh service instance (a restarted console)
// finds it again by those tags, a command that dies at once leaves a findable dead pane, and
// Stop ends a command with Ctrl+C (or a kill, when it ignores that). Unix sockets are blocked
// in the build sandbox, so this is skipped there and runs on the host and in CI.

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-sp-probe-'));
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

const previous = { dir: process.env.RAC_HOST_TMUX_DIR, bin: process.env.RAC_TMUX_BIN, path: process.env.RAC_HOST_PATH };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await run(tmux, ['-S', join(root, 'default'), 'kill-server']).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const [key, value] of [['RAC_HOST_TMUX_DIR', previous.dir], ['RAC_TMUX_BIN', previous.bin], ['RAC_HOST_PATH', previous.path]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A private tmux server, started without the operator's config, whose socket is named
// `default` so its directory stands in for RAC_HOST_TMUX_DIR. It holds one unmarked session,
// `fixture`, as the operator's own would be. The temp root doubles as the Worktree checkout the
// process runs in (its basename is what a session made for the Worktree is named).
async function fixture(command: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-sp-worktree-')));
  roots.push(root);
  const socket = join(root, 'default');
  expect((await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', 'cat'])).code).toBe(0);
  process.env.RAC_HOST_TMUX_DIR = root;
  process.env.RAC_TMUX_BIN = tmux;
  delete process.env.RAC_HOST_PATH;
  const worktree = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { dev: command } } });
  const service = () => new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never);
  const tmuxAt = async (...args: string[]) => (await run(tmux, ['-S', socket, ...args])).stdout.trim();
  return { root, worktree, service, tmuxAt };
}

describe.skipIf(!tmuxSocketsWork)('Stack process on a real tmux server', () => {
  it("keeps a long-running command live in a tagged window of the Workspace session, and a new instance finds it", async () => {
    const { root, worktree, service, tmuxAt } = await fixture('echo "dev server up in $PWD"; exec sleep 300');
    // the fixture session is this Worktree's Workspace, as a launch or a claim marks one
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const first = service();

    await expect(first.start(worktree.id, 'start')).resolves.toBe('started');
    // a login bash sources the operator's profile first, which can take a while
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain(`dev server up in ${root}`); }, { timeout: 10_000, interval: 100 });

    // it joined the Workspace session rather than making another, and its window is tagged,
    // kept on exit, and its pane marked as a process
    expect(await tmuxAt('list-sessions', '-F', '#{session_name}')).toBe('fixture');
    await vi.waitFor(async () => { expect(await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{@rac_worktree}|#{@rac_process}|#{remain-on-exit}|#{pane_dead}|#{@rac_role}')).toBe(`${root}|dev|on|0|process`); }, { timeout: 10_000, interval: 100 });
    expect(await first.state(worktree)).toMatchObject({ running: true, process: { name: 'dev', state: 'running' } });
    expect(await first.processOutput(worktree.id, 'dev')).toMatchObject({ state: 'running', output: expect.stringContaining(`dev server up in ${root}`) });

    // a restarted console keeps no memory of the process yet finds it, and Start is a no-op
    const second = service();
    await expect(second.state(worktree)).resolves.toEqual({ running: true, process: { name: 'dev', state: 'running' } });
    await expect(second.start(worktree.id, 'start')).resolves.toBe('started');
    // still one process window beside the fixture's own (whose empty tag the trim drops)
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{@rac_process}')).toBe('dev');
  });

  it('makes a Workspace session for a Worktree that has none, keeps a command that dies at once as a dead pane with its output, and Start reruns it there', async () => {
    // an `exit` runs a login shell's logout script, which on Debian clears the screen; each run
    // leaves a line in `runs` (the command runs in the checkout) so a rerun can be counted
    const { root, worktree, service, tmuxAt } = await fixture('echo run >> runs; echo "missing binary"; exit 3');
    const runs = async () => (await readFile(join(root, 'runs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const instance = service();

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    // the operator's unmarked session is left alone; a new one named for the checkout is marked
    const session = basename(root);
    expect((await tmuxAt('list-sessions', '-F', '#{session_name}')).split('\n').sort()).toEqual(['fixture', session].sort());
    expect(await tmuxAt('show-options', '-v', '-t', `=${session}:`, '@rac_place')).toBe(worktree.id);
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toEqual({ running: false, process: { name: 'dev', state: 'exited', exitCode: 3 } }); }, { timeout: 10_000, interval: 100 });
    expect(await tmuxAt('capture-pane', '-p', '-J', '-S', '-', '-t', `=${session}:dev`)).toContain('missing binary');
    // "Show dev output" reads the same dead pane, with its code
    expect(await instance.processOutput(worktree.id, 'dev')).toMatchObject({ name: 'dev', state: 'exited', exitCode: 3, output: expect.stringContaining('missing binary') });
    expect(await runs()).toBe(1);

    // Start after the crash respawns the command in the same pane, not a second window
    const pane = await tmuxAt('display-message', '-p', '-t', `=${session}:dev`, '#{pane_id}');
    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await runs()).toBe(2); }, { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toEqual({ running: false, process: { name: 'dev', state: 'exited', exitCode: 3 } }); }, { timeout: 10_000, interval: 100 });
    expect(await tmuxAt('list-panes', '-s', '-t', `=${session}:`, '-F', '#{pane_id}')).toBe(pane);
  });

  // tmux format-expands a session name and a start directory; a checkout folder named with a
  // format must come back literally (a harmless `#{pid}` stands in for a `#(command)`)
  it('names a new Workspace session for a checkout whose folder carries a tmux format, literally', async () => {
    const { root, tmuxAt } = await fixture('exec sleep 300');
    const checkout = join(root, 'app#{pid}');
    await mkdir(checkout);
    const worktree = testWorktree({ id: `proj:${checkout}`, projectId: 'proj', path: checkout, commands: { processes: { dev: 'echo "in $PWD"; exec sleep 300' } } });
    const service = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never);

    await expect(service.start(worktree.id, 'start')).resolves.toBe('started');
    expect((await tmuxAt('list-sessions', '-F', '#{session_name}')).split('\n')).toContain('app#{pid}');
    await vi.waitFor(async () => { expect(await service.state(worktree)).toMatchObject({ running: true }); }, { timeout: 10_000, interval: 100 });
  });

  // The process runs under a login bash and a subshell without job control, so they share one
  // process group and Ctrl+C reaches the command itself; its INT trap counts each interrupt,
  // proving it was the signal, not a kill, that ended it. The pane starts in copy mode, as an
  // operator scrolling its Terminal leaves it, where a bare Ctrl+C would only leave the mode.
  it('restarts a real command in its own pane and stops it with Ctrl+C, even from copy mode', async () => {
    const { root, worktree, service, tmuxAt } = await fixture(`trap 'echo interrupted >> interrupted; exit 0' INT; echo "dev up"; while :; do sleep 0.1; done`);
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const instance = service();
    const interrupts = async () => (await readFile(join(root, 'interrupted'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('dev up'); }, { timeout: 10_000, interval: 100 });
    const [pane, pid] = (await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{pane_id} #{pane_pid}')).split(' ');
    await tmuxAt('copy-mode', '-t', '=fixture:dev');

    await expect(instance.start(worktree.id, 'restart')).resolves.toBe('started');
    expect(await interrupts()).toBe(1);
    // the same pane, running a new process
    const [restartedPane, restartedPid] = (await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{pane_id} #{pane_pid}')).split(' ');
    expect(restartedPane).toBe(pane);
    expect(restartedPid).not.toBe(pid);
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toMatchObject({ running: true, process: { name: 'dev', state: 'running' } }); }, { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('dev up'); }, { timeout: 10_000, interval: 100 });

    await tmuxAt('copy-mode', '-t', '=fixture:dev');
    const began = Date.now();
    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    // well inside the 10 s budget, so Ctrl+C ended it rather than the kill
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(await interrupts()).toBe(2);
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'stopped' } });
    // the Workspace session and its own window outlive the process window
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{window_name}')).not.toContain('dev');
  }, 40_000);

  it('kills a real command that ignores Ctrl+C once the stop budget runs out', async () => {
    const { root, worktree, tmuxAt } = await fixture('trap "" INT; echo "$BASHPID" > pid; echo "stubborn up"; while :; do sleep 0.1; done');
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const instance = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never, undefined, undefined, undefined, undefined, { timeoutMs: 500, pollMs: 50 });

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('stubborn up'); }, { timeout: 10_000, interval: 100 });
    const pid = Number((await readFile(join(root, 'pid'), 'utf8')).trim());
    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'stopped' } });
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{window_name}')).not.toContain('dev');
    // the command itself is gone, not just its window
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 5_000, interval: 100 });
  }, 30_000);

  it('reports a process stopped before it ever ran, and makes no session by reading', async () => {
    const { worktree, service, tmuxAt } = await fixture('exec sleep 300');
    await expect(service().state(worktree)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'stopped' } });
    expect(await tmuxAt('list-sessions', '-F', '#{session_name}')).toBe('fixture');
  });
});
