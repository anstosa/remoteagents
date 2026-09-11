import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const fixtures: Array<{ root: string; socket: string }> = [];

// remove only test-owned tmux servers and files
afterEach(async () => {
  // stop isolated jobs before deleting their files
  for (const { root, socket } of fixtures.splice(0)) {
    await run(tmux, ['-S', socket, 'kill-server']);
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

// wait for a real subprocess state without relying on startup timing
async function eventually(check: () => Promise<boolean>): Promise<void> {
  // bound all fixture startup and resume waits
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // finish as soon as the observed state matches
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('tmux fixture did not reach the expected state');
}

// run a raw-mode program that deliberately ignores the ctrl-z byte
async function rawAgent(withShell: boolean, suspendSignal: 'stop' | 'ignore' | 'exit' = 'stop') {
  const root = await mkdtemp(join(tmpdir(), 'rac-suspend-'));
  const socket = join(root, 'tmux.sock');
  fixtures.push({ root, socket });
  vi.stubEnv('RAC_TMUX_BIN', tmux);
  const program = join(root, 'raw.cjs');
  const ready = join(root, 'ready');
  const ignored = join(root, 'ignored');
  const resumed = join(root, 'resumed');
  await writeFile(program, `
const { writeFileSync } = require('node:fs');
// retain the terminal without interpreting ctrl-z
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  // record the ignored suspend byte
  if (data.includes(26)) writeFileSync(${JSON.stringify(ignored)}, 'ignored');
});
// restore raw mode after foregrounding
process.on('SIGCONT', () => {
  process.stdin.setRawMode(true);
  writeFileSync(${JSON.stringify(resumed)}, 'resumed');
});
// simulate jobs that handle suspension without stopping
${suspendSignal === 'ignore' ? "process.on('SIGTSTP', () => {});" : ''}
${suspendSignal === 'exit' ? "process.on('SIGTSTP', () => process.exit(0));" : ''}
writeFileSync(${JSON.stringify(ready)}, 'ready');
`);
  const command = withShell ? ['/bin/bash', '--noprofile', '--norc', '-i'] : [process.execPath, program];
  expect((await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', ...command])).code).toBe(0);
  const adapter = new TmuxAdapter();
  const ref = { path: socket, fingerprint: 'fixture', device: 0, inode: 0 };
  // launch through the interactive shell so job control can reclaim the terminal
  if (withShell) expect(await adapter.input(ref, '%0', `${JSON.stringify(process.execPath)} ${JSON.stringify(program)}\r`)).toBe(true);
  await eventually(async () => await readFile(ready, 'utf8').catch(() => '') === 'ready');
  return { adapter, ref, ignored, resumed, socket };
}

// prove suspension against kernel job control rather than mocked command names
describe.skipIf(tmux === '' || process.platform !== 'linux')('tmux raw-mode suspension', () => {
  // preserve the agent while bypassing an ignored keyboard shortcut
  it('suspends and resumes a raw-mode foreground job that ignores ctrl-z', async () => {
    const { adapter, ref, ignored, resumed, socket } = await rawAgent(true);

    await expect(adapter.suspend(ref, '%0')).resolves.toBe(true);
    expect(await readFile(ignored, 'utf8')).toBe('ignored');
    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', '%0', '#{pane_current_command}'])).stdout.trim()).toBe('bash');
    await expect(adapter.foreground(ref, '%0')).resolves.toBe(true);
    await eventually(async () => await readFile(resumed, 'utf8').catch(() => '') === 'resumed');
  }, 20_000);

  // never stop a pane's own process when there is no shell to resume it
  it('rejects a raw-mode pane with no interactive parent shell', async () => {
    const { adapter, ref, ignored, resumed, socket } = await rawAgent(false);

    await expect(adapter.suspend(ref, '%0')).resolves.toBe(false);
    expect(await readFile(ignored, 'utf8')).toBe('ignored');
    await eventually(async () => await readFile(resumed, 'utf8').catch(() => '') === 'resumed');
    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', '%0', '#{pane_current_command}'])).stdout.trim()).toBe('node');
  }, 20_000);

  // recover the captured job when the kernel never returns the shell to the foreground
  it('continues the exact foreground job when forced suspension cannot finish', async () => {
    const { adapter, ref, resumed, socket } = await rawAgent(true, 'ignore');

    await expect(adapter.suspend(ref, '%0')).resolves.toBe(false);
    await eventually(async () => await readFile(resumed, 'utf8').catch(() => '') === 'resumed');
    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', '%0', '#{pane_current_command}'])).stdout.trim()).toBe('node');
  }, 20_000);

  // never mistake an exited job for a resumable suspended agent
  it('rejects a foreground job that exits on the suspend signal', async () => {
    const { adapter, ref, socket } = await rawAgent(true, 'exit');

    await expect(adapter.suspend(ref, '%0')).resolves.toBe(false);
    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', '%0', '#{pane_current_command}'])).stdout.trim()).toBe('bash');
  }, 20_000);
});
