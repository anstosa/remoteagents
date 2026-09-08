import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
// decode checkout paths before passing them to subprocesses
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const directories: string[] = [];
const sockets: string[] = [];
const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();

// remove only test-owned servers and files
afterEach(async () => {
  // stop isolated servers before removing their sockets
  for (const socket of sockets.splice(0)) await execute(tmux, ['-S', socket, 'kill-server']).catch(() => {});
  // remove isolated installation fixtures
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// isolate host configuration from the operator
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-host-tmux-'));
  directories.push(directory);
  return directory;
}

// lock boot recovery without changing ownership of existing sessions
describe('host tmux bridge recovery', () => {
  // exercise real socket behavior when tmux is available
  it.skipIf(tmux === '')('survives empty sessions, preserves running sessions, and recovers a stale socket', async () => {
    const root = await fixture();
    const socketDirectory = join(root, 'sockets');
    const socket = join(socketDirectory, 'default');
    sockets.push(socket);
    const binary = join(root, 'tmux');
    await writeFile(binary, '#!/bin/sh\nexec "$TEST_TMUX" -f /dev/null "$@"\n', { mode: 0o700 });
    const maskFile = join(root, 'umask');
    // preserve the caller's mask while creating private socket storage
    const ensure = () => execute('/bin/bash', ['-c', 'umask 022; exec "$@"', 'host-tmux-test', '/bin/bash', join(repository, 'scripts/ensure-host-tmux.sh'), binary, socketDirectory], { env: { ...process.env, TEST_TMUX: tmux, TEST_UMASK_FILE: maskFile } });
    // query only the fixture socket
    const query = async (...args: string[]) => (await execute(tmux, ['-S', socket, ...args])).stdout.trim();

    await ensure();
    expect((await stat(socketDirectory)).mode & 0o777).toBe(0o700);
    await query('run-shell', 'umask > "$TEST_UMASK_FILE"');
    expect((await readFile(maskFile, 'utf8')).trim()).toBe('0022');
    expect((await stat(maskFile)).mode & 0o777).toBe(0o644);
    expect(await query('show-options', '-sv', 'exit-empty')).toBe('off');
    const pid = await query('display-message', '-p', '#{pid}');
    await query('new-session', '-d', '-s', 'existing', '/bin/sleep', '60');
    await query('set-option', '-p', '-t', '=existing:', '@test-marker', 'preserved');
    await ensure();
    expect(await query('display-message', '-p', '#{pid}')).toBe(pid);
    expect(await query('show-options', '-pv', '-t', '=existing:', '@test-marker')).toBe('preserved');
    await query('kill-session', '-t', '=existing:');
    expect(await query('show-options', '-sv', 'exit-empty')).toBe('off');

    await query('kill-server');
    expect((await stat(socket)).isSocket()).toBe(true);
    await ensure();
    expect(await query('show-options', '-sv', 'exit-empty')).toBe('off');
    expect(await query('display-message', '-p', '#{pid}')).not.toBe(pid);
  });

  // cover explicit sockets and the default for a non-1000 host uid
  it.each([false, true])('installs portable recovery without killing tmux (custom socket: %s)', async (customSocket) => {
    const root = await fixture();
    const bin = join(root, 'bin');
    const systemdBin = join(root, 'scope $tools');
    await mkdir(bin);
    await mkdir(systemdBin);
    const calls = join(root, 'systemctl.log');
    await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG"\n', { mode: 0o700 });
    await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "1234\\n"\n', { mode: 0o700 });
    await writeFile(join(bin, 'loginctl'), '#!/bin/sh\nprintf "yes\\n"\n', { mode: 0o700 });
    // simulate both legacy and modern systemd scope argument handling
    await writeFile(join(systemdBin, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' '${customSocket ? '--expand-environment=BOOL' : '--scope'}'\n`, { mode: 0o700 });
    const binary = join(bin, 'host tmux');
    // mirror explicit and uid-derived socket paths
    const socketDirectory = customSocket ? join(root, 'host sockets') : join(root, '.local/state/tmux/tmux-1234');
    await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await execute('/bin/bash', [join(repository, 'scripts/install-host-tmux.sh')], { env: {
      ...process.env, HOME: root, PATH: `${systemdBin}:${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, 'config'),
      TMUX_BIN: binary, HOST_TMUX_DIR: customSocket ? socketDirectory : '', TEST_SYSTEMCTL_LOG: calls
    } });
    const units = join(root, 'config/systemd/user');
    const service = await readFile(join(units, 'remote-agent-tmux.service'), 'utf8');
    const timer = await readFile(join(units, 'remote-agent-tmux.timer'), 'utf8');

    expect(service).toContain('Type=oneshot');
    // keep recovered servers outside the repeatedly stopped check unit
    expect(service).toContain(`ExecStart="${join(systemdBin, 'systemd-run')}" --user --scope --collect --quiet `);
    expect(service.includes('--expand-environment=no')).toBe(customSocket);
    expect(service).toContain('KillMode=process');
    expect(service).not.toContain('UMask=0077');
    expect(service).not.toContain('RemainAfterExit=yes');
    expect(service).toContain(`"${binary}" "${socketDirectory}"`);
    expect(timer).toContain('OnBootSec=5s');
    expect(timer).toContain('OnUnitInactiveSec=30s');
    expect(timer).toContain('WantedBy=timers.target');
    expect(await readFile(calls, 'utf8')).toContain('--user enable --now remote-agent-tmux.timer');
    expect(await readFile(calls, 'utf8')).toContain('--user start remote-agent-tmux.service');
    expect(await readFile(calls, 'utf8')).not.toMatch(/restart|kill|stop/);
  });
});
