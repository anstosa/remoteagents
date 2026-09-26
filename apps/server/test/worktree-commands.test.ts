import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

// mirror the service's tmux-safe worktree token: `<projectId>-<sha256(path)[0:12]>`
const worktreeToken = (projectId: string, path: string) => `${projectId}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;
const stackSession = (projectId: string, path: string) => `rac-stack-${worktreeToken(projectId, path)}-build-exclusive`;

const previousTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const previousTmuxBinary = process.env.RAC_TMUX_BIN;
const previousHostPath = process.env.RAC_HOST_PATH;
const previousHostWorkspace = process.env.RAC_HOST_WORKSPACE;
const worktree = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, commands: { build: 'docker compose build' } });
const config = testConfig();
const discovery = { worktreesNow: () => [worktree] };

let checkoutRoot: string | undefined;

afterEach(async () => {
  // restore the host socket setting
  if (previousTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = previousTmuxDirectory;
  // restore the host tmux client setting
  if (previousTmuxBinary === undefined) delete process.env.RAC_TMUX_BIN;
  else process.env.RAC_TMUX_BIN = previousTmuxBinary;
  // restore the host executable path setting
  if (previousHostPath === undefined) delete process.env.RAC_HOST_PATH;
  else process.env.RAC_HOST_PATH = previousHostPath;
  // restore the host workspace override
  if (previousHostWorkspace === undefined) delete process.env.RAC_HOST_WORKSPACE;
  else process.env.RAC_HOST_WORKSPACE = previousHostWorkspace;
  // clean only a created checkout fixture
  if (checkoutRoot !== undefined) { await rm(checkoutRoot, { recursive: true, force: true }); checkoutRoot = undefined; }
});

describe('worktree stack commands', () => {
  it('reports the active operation until its tmux session exits', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_TMUX_BIN = '/host-tools/tmux';
    process.env.RAC_HOST_PATH = '/opt/operator/bin:/usr/bin:/bin';
    delete process.env.RAC_HOST_WORKSPACE;
    let active = true;
    let session = '';
    const binaries: string[] = [];
    const command = async (binary: string, args: string[]) => {
      binaries.push(binary);
      // capture the launched operation
      if (args.includes('new-session')) {
        session = args[args.indexOf('-s') + 1] ?? '';
        expect(args.at(-1)).toContain("export PATH='/opt/operator/bin:/usr/bin:/bin'");
        return { code: 0, stdout: '' };
      }
      // report the synthetic session state
      if (args.includes('has-session')) return { code: active ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);

    await expect(service.run(worktree.id, 'build')).resolves.toBe(true);
    // session/file names use a tmux-safe `<projectId>-<hash>` token, not the path-bearing wire id
    expect(session).toMatch(/^rac-stack-proj-[0-9a-f]{12}-build-exclusive$/);
    await expect(service.state(worktree)).resolves.toEqual({ operation: 'build' });
    active = false;
    await expect(service.state(worktree)).resolves.toEqual({});
    expect(new Set(binaries)).toEqual(new Set(['/host-tools/tmux']));
  });

  it('detects a running stack operation but ignores transient status probes (Remove blocker)', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const other = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', hostPath: '/home/ubuntu/dana', pinned: false });
    const { createHash } = await import('node:crypto');
    const probeSession = `rac-stack-proj-${createHash('sha256').update(worktree.path).digest('hex').slice(0, 12)}-a1b2c3d4e5f6`;
    const command = async (_binary: string, args: string[]) => {
      // an exclusive operation session for `worktree`, plus unrelated + probe sessions
      if (args.includes('list-sessions')) return { code: 0, stdout: `${stackSession('proj', worktree.path)}\nrac-launch-x\nsome-shell\n` };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);
    // only the Worktree whose exclusive operation session is present is blocked
    await expect(service.sessionRunning(worktree)).resolves.toBe(true);
    await expect(service.sessionRunning(other)).resolves.toBe(false);

    // a transient `rac-stack-<token>-<hex>` status probe is not an operation and never blocks
    const probing = async (_binary: string, args: string[]) => (args.includes('list-sessions') ? { code: 0, stdout: `${probeSession}\n` } : { code: 1, stdout: '' });
    await expect(new WorktreeCommandService(config, discovery as never, probing).sessionRunning(worktree)).resolves.toBe(false);
  });

  // two branches of one Project run their stacks side by side: each Worktree gets its
  // own exclusive session and log file named by its token, state is per Worktree, and
  // the host-side paths come from the Project declared at the server's own checkout —
  // port conflicts between the two stacks are the operator's business, never the console's
  it('runs stacks in two Worktrees of one Project concurrently', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { build: 'make build', migrate: 'make migrate' } });
    const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, branch: 'dana', commands: { build: 'make ui' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const live = new Set<string>();
    const scripts = new Map<string, string>();
    const fake = async (_binary: string, args: string[]) => {
      // capture each launched session and its script
      if (args.includes('new-session')) {
        const session = args[args.indexOf('-s') + 1] ?? '';
        live.add(session);
        scripts.set(session, args.at(-1) ?? '');
        return { code: 0, stdout: '' };
      }
      // report the synthetic session state
      if (args.includes('has-session')) return { code: live.has((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')) ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora, dana] } as never, fake, checkoutRoot);

    await expect(service.start(cora.id, 'build')).resolves.toBe('started');
    await expect(service.start(dana.id, 'build')).resolves.toBe('started');
    // only the same Worktree is serialized; the sibling never is
    await expect(service.start(cora.id, 'build')).resolves.toBe('busy');
    const coraSession = stackSession('proj', cora.path);
    const danaSession = stackSession('proj', dana.path);
    expect([...live]).toEqual([coraSession, danaSession]);

    // each command runs in its own Worktree and writes its own log, host-side, under
    // the checkout of the Project whose path is the server's own
    const logName = (script: string, projectId: string, path: string) => new RegExp(`> '/host/checkout/\\.data/stack-logs/(${worktreeToken(projectId, path)}-[0-9a-f]{18}\\.log)'`, 'u').exec(script)?.[1];
    const coraLog = logName(scripts.get(coraSession) ?? '', 'proj', cora.path);
    const danaLog = logName(scripts.get(danaSession) ?? '', 'proj', dana.path);
    expect(scripts.get(coraSession)).toContain("cd -- '/host/cora'");
    expect(scripts.get(danaSession)).toContain("cd -- '/worktrees/dana'");
    // select each checkout's command set rather than the project default
    expect(scripts.get(coraSession)).toContain('make build');
    expect(scripts.get(danaSession)).toContain('make ui');
    expect(service.actions(cora)).toEqual(['build', 'migrate']);
    expect(service.actions(dana)).toEqual(['build']);
    await expect(service.start(dana.id, 'migrate')).resolves.toBe(false);
    expect(coraLog).toBeDefined();
    expect(danaLog).toBeDefined();
    expect(coraLog).not.toBe(danaLog);

    // stack state on the dashboard is per Worktree
    await expect(service.state(cora)).resolves.toEqual({ operation: 'build' });
    await expect(service.state(dana)).resolves.toEqual({ operation: 'build' });
    live.delete(coraSession);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.state(dana)).resolves.toEqual({ operation: 'build' });

    // each Worktree's output is read back from its own console-side file
    await writeFile(join(checkoutRoot, '.data', 'stack-logs', coraLog!), 'cora output');
    await writeFile(join(checkoutRoot, '.data', 'stack-logs', danaLog!), 'dana output');
    await expect(service.log(cora.id)).resolves.toMatchObject({ action: 'build', active: false, output: 'cora output' });
    await expect(service.log(dana.id)).resolves.toMatchObject({ action: 'build', active: true, output: 'dana output' });
  });

  // status probes are per Worktree too: each writes its own `stack-<token>-<hex>` file
  // under the server checkout's `.data`, host-side through the declared Project
  it('probes stack status per Worktree under the server checkout', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'stack status' } });
    const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, branch: 'dana', commands: { status: 'stack status' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const statusFiles: string[] = [];
    const fake = async (_binary: string, args: string[]) => {
      // the host-side probe writes its exit code; mirror it through the mount
      if (!args.includes('new-window')) return { code: 1, stdout: '' };
      const hostFile = /> '(\/host\/checkout\/[^']+)'/u.exec(args.at(-1) ?? '')?.[1];
      if (hostFile === undefined) return { code: 1, stdout: '' };
      statusFiles.push(hostFile);
      await writeFile(join(checkoutRoot!, hostFile.slice('/host/checkout/'.length)), hostFile.includes(worktreeToken('proj', cora.path)) ? '0' : '1');
      return { code: 0, stdout: `@${statusFiles.length}\n` };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora, dana] } as never, fake, checkoutRoot);

    // the first read triggers each probe; the cache then settles per Worktree
    await expect(service.running(cora)).resolves.toBeUndefined();
    await expect(service.running(dana)).resolves.toBeUndefined();
    await vi.waitFor(async () => {
      expect(await service.running(cora)).toBe(true);
      expect(await service.running(dana)).toBe(false);
    });
    const coraFile = statusFiles.find(file => file.includes(worktreeToken('proj', cora.path)));
    const danaFile = statusFiles.find(file => file.includes(worktreeToken('proj', dana.path)));
    expect(coraFile).toContain(`/host/checkout/.data/stack-status/stack-${worktreeToken('proj', cora.path)}-`);
    expect(danaFile).toContain(`/host/checkout/.data/stack-status/stack-${worktreeToken('proj', dana.path)}-`);
  });

  // Regression (2026-09-17): a session per probe closed a session on every refresh, firing the
  // operator's tmux `session-closed` hook — a `choose-tree` hook then opened the session picker
  // over the pane in use every ~30s, where it also swallowed a submitted prompt's Enter. Probes
  // must run as windows of one holder session, so refreshing never creates or closes a session.
  it('runs status probes as windows of one holder session, never a session per probe', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'stack status' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const sessions: string[] = [];
    const closedSessions: string[][] = [];
    let windows = 0;
    const fake = async (_binary: string, args: string[]) => {
      if (args.includes('kill-session')) { closedSessions.push(args); return { code: 0, stdout: '' }; }
      if (args.includes('new-session')) { sessions.push(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
      if (!args.includes('new-window')) return { code: 1, stdout: '' };
      // the holder does not exist until the service creates it
      if (sessions.length === 0) return { code: 1, stdout: '', stderr: "can't find session: rac-stack-probes" };
      expect(args[args.indexOf('-t') + 1]).toBe('=rac-stack-probes:');
      const hostFile = /> '(\/host\/checkout\/[^']+)'/u.exec(args.at(-1) ?? '')?.[1];
      await writeFile(join(checkoutRoot!, hostFile!.slice('/host/checkout/'.length)), '0');
      windows += 1;
      return { code: 0, stdout: `@${windows}\n` };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora] } as never, fake, checkoutRoot);
    const cache = (service as unknown as { statusCache: Map<string, unknown> }).statusCache;

    // three full refreshes (the cache expired between each)
    for (let round = 1; round <= 3; round += 1) {
      cache.clear();
      await service.running(cora);
      await vi.waitFor(async () => { expect(windows).toBe(round); expect(await service.running(cora)).toBe(true); });
    }
    // one holder session for all of them, and no session was ever closed
    expect(sessions).toEqual(['rac-stack-probes']);
    expect(closedSessions).toEqual([]);
  });

  // A quick command's window closes itself when it exits, but one that hangs (never writing
  // its marker) would linger while the next dashboard build spawns another beside it — the
  // pile-up this guards against.
  it('kills a status probe window that never answers, so probes never pile up', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'sleep 999' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const created: string[] = [];
    const killed: string[] = [];
    const live = new Set<string>();
    // model a probe whose command hangs: the window is created but never writes its marker,
    // so only an explicit kill removes it from the tmux server
    const fake = async (_binary: string, args: string[]) => {
      if (args.includes('new-window')) { const id = `@${created.length + 1}`; created.push(id); live.add(id); return { code: 0, stdout: `${id}\n` }; }
      if (args.includes('kill-window')) { const id = args[args.indexOf('-t') + 1] ?? ''; killed.push(id); live.delete(id); return { code: 0, stdout: '' }; }
      return { code: 1, stdout: '' };
    };
    // a tight probe budget so the hang is abandoned in milliseconds, not the 2s default
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora] } as never, fake, checkoutRoot, undefined, { timeoutMs: 60, pollMs: 10 });

    // kick a probe; the command hangs, so the bounded poll gives up — and the window must be
    // killed rather than abandoned, leaving nothing running for a later probe to accumulate on
    await expect(service.running(cora)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(created).toHaveLength(1);
      expect(killed).toEqual(created);
      expect(live.size).toBe(0);
    });
  });

  // the preview health probe reads each Worktree record's Project URL
  it('probes the Project preview from each Worktree record', async () => {
    const upstream = createServer((_request, response) => { response.end('ok'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    try {
      const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', projectUrl: url });
      const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, projectUrl: url });
      const service = new WorktreeCommandService(config, { worktreesNow: () => [cora, dana] } as never, async () => ({ code: 1, stdout: '' }));
      // the first read triggers the probe; both Worktrees settle on the shared URL
      await expect(service.state(cora)).resolves.toEqual({});
      await vi.waitFor(async () => {
        expect(await service.state(cora)).toEqual({ tunnel: true });
        expect(await service.state(dana)).toEqual({ tunnel: true });
      });
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it("probes tmux's default socket for a stack session in native mode", async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const calls: string[][] = [];
    const command = async (_binary: string, args: string[]) => {
      calls.push(args);
      return args.includes('list-sessions') ? { code: 0, stdout: `${stackSession('proj', worktree.path)}\n` } : { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);
    // a native deployment reaches tmux directly, so its exclusive operation session is found
    await expect(service.sessionRunning(worktree)).resolves.toBe(true);
    // and every tmux call targets the default socket: no '-S' selector
    expect(calls.every(args => !args.includes('-S'))).toBe(true);
  });
});

// A small in-memory tmux: sessions with options, one pane per window with its own pane options,
// the `;` command sequences the service chains (with `\;` as an escaped literal), a `-c` start
// directory format-expanded as tmux does it (a `#(…)` there would run, and is recorded in
// `formatCommands`), `set-option` scoped by `-p`/`-w` or else to the target's session, and a
// `list-panes` that lists every session with `-a`, a session's windows with `-s`, else its
// active window only. A session target must be `=name:`, as real tmux reads a bare `=name` as
// a window. `fail` makes every call fail as tmux does when it cannot run.
type FakeWindow = { id: string; paneId: string; session: string; options: Map<string, string>; paneOptions: Map<string, string>; dead: boolean; status?: number; command: string[]; cwd?: string };
function fakeTmux() {
  const sessions = new Map<string, Map<string, string>>();
  // tmux's stable `$N` session ids, by name
  const sessionIds = new Map<string, string>();
  const idOf = (session: string) => { if (!sessionIds.has(session)) sessionIds.set(session, `$${sessionIds.size + 1}`); return sessionIds.get(session)!; };
  // a `=name:` or `$N:` session target's session name, if it names one
  const sessionOf = (target: string) => { const bare = target.replace(/^=|:$/gu, ''); return bare.startsWith('$') ? [...sessionIds].find(([, id]) => id === bare)?.[0] : bare; };
  const windows: FakeWindow[] = [];
  const calls: string[][] = [];
  const events: string[] = [];
  let nextWindow = 1;
  const state = { fail: false };
  const formatCommands: string[] = [];
  // `##` collapses to `#`; an undoubled `#(` is a shell command the tmux server would run
  const expand = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const command = /(?:^|[^#])(?:##)*#\(([^)]*)\)/u.exec(value)?.[1];
    if (command !== undefined) formatCommands.push(command);
    return value.replaceAll('##', '#');
  };
  const value = (args: string[], flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const find = (target: string | undefined) => windows.find(entry => entry.id === target || entry.paneId === target);
  const openWindow = (session: string, command: string[], cwd?: string) => { const id = nextWindow++; const entry: FakeWindow = { id: `@${id}`, paneId: `%${id}`, session, options: new Map(), paneOptions: new Map(), dead: false, command, ...(cwd === undefined ? {} : { cwd: expand(cwd)! }) }; windows.push(entry); return entry; };
  const missing = (session: string) => ({ code: 1, stdout: '', stderr: `can't find session: ${session}` });
  const format = (template: string, entry: FakeWindow) => template.replace(/#\{([^}]+)\}/gu, (_match, key: string) => {
    if (key.startsWith('@')) return entry.paneOptions.get(key) ?? entry.options.get(key) ?? sessions.get(entry.session)?.get(key) ?? '';
    const fields: Record<string, string> = { session_id: idOf(entry.session), window_id: entry.id, pane_id: entry.paneId, session_name: entry.session, pane_dead: entry.dead ? '1' : '0', pane_dead_status: entry.dead ? String(entry.status ?? 0) : '' };
    return fields[key] ?? '';
  });
  // the trailing shell command of a tmux command, after its flags
  const commandOf = (args: string[], valueFlags: string[]) => { let index = 1; while (index < args.length && args[index]!.startsWith('-')) index += valueFlags.includes(args[index]!) ? 2 : 1; return args.slice(index); };
  const dispatch = (args: string[]): { code: number; stdout: string; stderr?: string } => {
    const [verb] = args;
    if (verb === 'new-session') {
      const name = expand(value(args, '-s'))!;
      if (sessions.has(name)) return { code: 1, stdout: '', stderr: `duplicate session: ${name}` };
      sessions.set(name, new Map());
      const entry = openWindow(name, commandOf(args, ['-s', '-n', '-c', '-F']), value(args, '-c'));
      events.push(`session ${name}`);
      return { code: 0, stdout: args.includes('-P') ? `${format(value(args, '-F') ?? '', entry)}\n` : '' };
    }
    if (verb === 'list-sessions') return { code: 0, stdout: [...sessions.keys()].map(name => `${name}\n`).join('') };
    if (verb === 'set-option') {
      const target = value(args, '-t')!;
      const [name, setting] = args.slice(-2) as [string, string];
      if (target.startsWith('=')) {
        // a session target is `=name:`; tmux reads a bare `=name` as a window, which fails here
        const options = target.endsWith(':') ? sessions.get(target.slice(1, -1)) : undefined;
        if (options === undefined) return { code: 1, stdout: '', stderr: `no such session: ${target}` };
        options.set(name, setting);
      } else {
        const entry = find(target);
        if (entry === undefined) return { code: 1, stdout: '', stderr: `can't find pane: ${target}` };
        (args.includes('-p') ? entry.paneOptions : args.includes('-w') ? entry.options : sessions.get(entry.session)!).set(name, setting);
      }
      events.push(`set ${target} ${name}=${setting}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'new-window') {
      const target = value(args, '-t')!;
      const session = sessionOf(target);
      if (!target.endsWith(':') || session === undefined || !sessions.has(session)) return missing(target);
      const entry = openWindow(session, commandOf(args, ['-t', '-c', '-F', '-n']), value(args, '-c'));
      events.push(`window ${entry.id} ${session}`);
      return { code: 0, stdout: args.includes('-P') ? `${format(value(args, '-F') ?? '', entry)}\n` : '' };
    }
    if (verb === 'respawn-pane') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      if (!entry.dead && !args.includes('-k')) return { code: 1, stdout: '', stderr: 'pane still active' };
      Object.assign(entry, { dead: false, status: undefined, command: commandOf(args, ['-t', '-c']), cwd: expand(value(args, '-c')) });
      events.push(`respawn ${entry.id}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'kill-window') {
      const target = find(value(args, '-t')); const index = target === undefined ? -1 : windows.indexOf(target);
      if (index >= 0) { const [killed] = windows.splice(index, 1); if (!windows.some(entry => entry.session === killed!.session)) sessions.delete(killed!.session); }
      return { code: 0, stdout: '' };
    }
    if (verb === 'list-panes') {
      if (sessions.size === 0) return { code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default' };
      let listed = windows;
      if (!args.includes('-a')) {
        const target = value(args, '-t')!;
        const session = target.replace(/^=|:$/gu, '');
        if (!target.endsWith(':') || !sessions.has(session)) return target.endsWith(':') ? missing(session) : { code: 1, stdout: '', stderr: `can't find window: ${session}` };
        const own = windows.filter(entry => entry.session === session);
        listed = args.includes('-s') ? own : own.slice(0, 1);
      }
      return { code: 0, stdout: listed.map(entry => `${format(value(args, '-F')!, entry)}\n`).join('') };
    }
    return { code: 1, stdout: '' };
  };
  const command = async (_binary: string, argv: string[]) => {
    calls.push(argv);
    if (state.fail) throw new Error('spawn /usr/bin/tmux ENOENT');
    const args = argv[0] === '-S' ? argv.slice(2) : argv;
    let stdout = '';
    // a `;` sequence stops at its first failing command, as tmux's does
    for (const part of args.join('\u0000').split('\u0000;\u0000')) {
      const result = dispatch(part.split('\u0000').map(arg => arg.endsWith('\\;') ? `${arg.slice(0, -2)};` : arg));
      if (result.code !== 0) return result;
      stdout += result.stdout;
    }
    return { code: 0, stdout };
  };
  // a Workspace session the console (or a claim) marked for a Place, holding one idle shell
  const seedWorkspace = (session: string, placeId: string) => {
    sessions.set(session, new Map([['@rac_place', placeId]]));
    return openWindow(session, ['/bin/bash', '-l']);
  };
  // a Stack process window already in a session, as a previous console instance left it
  const seedProcess = (session: string, worktreePath: string, name: string, dead = false, status?: number) => {
    if (!sessions.has(session)) sessions.set(session, new Map());
    const entry = openWindow(session, ['/bin/bash', '-lc', 'pnpm dev']);
    entry.options.set('remain-on-exit', 'on').set('@rac_worktree', worktreePath).set('@rac_process', name);
    entry.paneOptions.set('@rac_role', 'process');
    Object.assign(entry, { dead, ...(status === undefined ? {} : { status }) });
    return entry;
  };
  return { command, calls, events, sessions, windows, state, formatCommands, seedWorkspace, seedProcess };
}

describe('worktree Stack process', () => {
  const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' } });
  const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, commands: { processes: { dev: 'pnpm dev' } } });
  const erin = testWorktree({ id: 'proj:/worktrees/erin', projectId: 'proj', path: '/worktrees/erin', main: false, commands: { processes: { web: 'cd web && pnpm dev' } } });
  const processService = (tmux: ReturnType<typeof fakeTmux>, worktrees = [cora, dana, erin]) => new WorktreeCommandService(config, { worktreesNow: () => worktrees } as never, tmux.command);
  const processWindows = (tmux: ReturnType<typeof fakeTmux>) => tmux.windows.filter(entry => entry.options.has('@rac_process'));
  // native mode unless a test bridges: tmux's default socket and no host PATH
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });

  // Stop and Restart join Start once they are implemented, rather than offer actions that fail
  it('offers Start beside the configured one-shot commands', async () => {
    const service = processService(fakeTmux());
    expect(service.actions(cora)).toEqual(['start', 'build']);
    expect(service.actions(dana)).toEqual(['start']);
    await expect(service.start(cora.id, 'stop')).resolves.toBe(false);
  });

  it("starts the process in a tagged, remain-on-exit window of the Worktree's Workspace session", async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_TMUX_BIN = '/host-tools/tmux';
    process.env.RAC_HOST_PATH = '/opt/operator/bin:/usr/bin:/bin';
    const tmux = fakeTmux();
    tmux.seedWorkspace('dana', dana.id);
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');

    // it joins the session marked as cora's Workspace, creating none
    expect([...tmux.sessions.keys()]).toEqual(['dana', 'cora']);
    const [window] = processWindows(tmux);
    expect(window?.session).toBe('cora');
    // tagged, kept on exit, and marked as a process pane before its command ever runs
    expect(Object.fromEntries(window!.options)).toEqual({ 'remain-on-exit': 'on', '@rac_worktree': '/worktrees/cora', '@rac_process': 'dev' });
    expect(Object.fromEntries(window!.paneOptions)).toEqual({ '@rac_role': 'process' });
    expect(tmux.events.indexOf(`respawn ${window!.id}`)).toBeGreaterThan(tmux.events.indexOf(`set ${window!.id} @rac_process=dev`));
    // wrapped as a stack command (login bash, host PATH, the Worktree host root), in a subshell
    expect(window!.cwd).toBe('/host/cora');
    expect(window!.command).toEqual(['/bin/bash', '-lc', "export PATH='/opt/operator/bin:/usr/bin:/bin'; ( cd -- '/host/cora' && { pnpm dev; } )"]);
    // on the host socket, through the host tmux client, like every stack command
    expect(tmux.calls.every(args => args[0] === '-S' && args[1] === '/host-tmux/default')).toBe(true);

    await expect(service.state(cora)).resolves.toEqual({ running: true, transition: 'starting', process: { name: 'dev', state: 'running' } });
  });

  // a Worktree with no Agent or Terminal open yet gets its Workspace session the way a launch
  // makes one: named for the checkout (suffixed past a taken name) and marked for the Worktree
  it('creates the Workspace session, named and marked like a launch, when the Worktree has none', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('dana', dana.id);
    // the operator's own session of the same name, unmarked, is never joined or displaced
    tmux.sessions.set('cora', new Map());
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect([...tmux.sessions.keys()]).toEqual(['dana', 'cora', 'cora-2']);
    expect(tmux.sessions.get('cora-2')?.get('@rac_place')).toBe(cora.id);
    // the process window is the new session's only window
    expect(tmux.windows.filter(entry => entry.session === 'cora-2')).toEqual(processWindows(tmux));
    expect(processWindows(tmux)[0]?.paneOptions.get('@rac_role')).toBe('process');
    await expect(service.state(cora)).resolves.toMatchObject({ running: true, process: { name: 'dev', state: 'running' } });
  });

  it('does nothing when the process is already running', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const before = tmux.calls.length;
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect(tmux.windows).toHaveLength(2);
    expect(tmux.calls.slice(before).map(args => args[0])).toEqual(['list-panes']);
    await expect(service.state(cora)).resolves.toEqual({ running: true, process: { name: 'dev', state: 'running' } });
  });

  // nothing about a process is remembered in memory: a restarted console reads it from tmux,
  // in whichever session it lives
  it('finds each Worktree process by the tags on its window, never by a status probe', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    tmux.seedProcess('dana-2', '/worktrees/dana', 'dev', true, 127);
    // an orphan whose Worktree is no longer configured, and a process renamed in config
    tmux.seedProcess('gone', '/worktrees/gone', 'dev');
    tmux.seedProcess('erin', '/worktrees/erin', 'dev');
    const service = processService(tmux);

    await expect(service.state(cora)).resolves.toEqual({ running: true, process: { name: 'dev', state: 'running' } });
    await expect(service.state(dana)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'exited', exitCode: 127 } });
    await expect(service.state(erin)).resolves.toEqual({ running: false, process: { name: 'web', state: 'stopped' } });
    // reading state never opens a window: no status probe runs for a process Worktree
    expect(tmux.calls.every(args => args[0] === 'list-panes')).toBe(true);
  });

  it('reports a process stopped when no tmux server is running, and starts none by reading', async () => {
    const tmux = fakeTmux();
    await expect(processService(tmux).state(cora)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'stopped' } });
    expect(tmux.sessions.size).toBe(0);
  });

  it('leaves the state unknown and fails Start, without throwing, when tmux cannot run', async () => {
    const tmux = fakeTmux();
    tmux.state.fail = true;
    const service = processService(tmux);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
  });

  // a socket that exists but refuses the console is not "no processes"
  it('leaves the state unknown when the tmux socket refuses the connection', async () => {
    const refused = async () => ({ code: 1, stdout: '', stderr: 'error connecting to /host-tmux/default (Permission denied)' });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, refused);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
  });

  it('reruns an exited process in its own window rather than opening another', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 1);
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect(processWindows(tmux)).toEqual([crashed]);
    expect(tmux.events).toContain(`respawn ${crashed.id}`);
    expect(crashed.command.at(-1)).toContain('pnpm dev');
    await expect(service.state(cora)).resolves.toMatchObject({ running: true, process: { name: 'dev', state: 'running' } });
  });

  // a command that dies at once has nothing left to start: the badge shows it down straight
  // away rather than "Starting…" (which also locks the stack menu) for the next minute
  it('drops the Starting transition once the process is not running', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);
    await service.start(cora.id, 'start');
    await expect(service.state(cora)).resolves.toMatchObject({ transition: 'starting' });
    Object.assign(processWindows(tmux)[0]!, { dead: true, status: 127 });
    await expect(service.state(cora)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'exited', exitCode: 127 } });
  });

  // a checkout path is agent-controlled: an Agent can create a Worktree whose path carries a
  // tmux format or ends in the `;` tmux reads as a command separator
  it('passes a hostile checkout path to tmux as a literal', async () => {
    const tmux = fakeTmux();
    const path = '/worktrees/x#(touch pwned);';
    const hostile = testWorktree({ id: `proj:${path}`, projectId: 'proj', path, commands: { processes: { dev: 'pnpm dev' } } });
    const service = processService(tmux, [hostile]);

    await expect(service.start(hostile.id, 'start')).resolves.toBe('started');
    expect(tmux.formatCommands).toEqual([]);
    const [window] = processWindows(tmux);
    expect(window?.cwd).toBe(path);
    expect(window?.options.get('@rac_worktree')).toBe(path);
    expect(tmux.sessions.get(window!.session)?.get('@rac_place')).toBe(hostile.id);
    await expect(service.state(hostile)).resolves.toMatchObject({ running: true });
  });

  it('removes a half-made window rather than leave an untagged or idle one behind', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const command = tmux.command;
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => args[0] === 'respawn-pane' ? { code: 1, stdout: '', stderr: 'respawn failed' } : await command(binary, args));
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
    // only the Workspace's own shell remains
    expect(tmux.windows.map(entry => entry.session)).toEqual(['cora']);
    expect(processWindows(tmux)).toEqual([]);
    await expect(service.state(cora)).resolves.toEqual({ running: false, process: { name: 'dev', state: 'stopped' } });
  });

  it('refuses a second Start on the same Worktree while one is in flight', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedWorkspace('dana', dana.id);
    const service = processService(tmux);
    const results = await Promise.all([service.start(cora.id, 'start'), service.start(cora.id, 'start'), service.start(dana.id, 'start')]);
    expect(results).toEqual(['started', 'busy', 'started']);
    expect(processWindows(tmux).map(entry => entry.options.get('@rac_worktree'))).toEqual(['/worktrees/cora', '/worktrees/dana']);
  });

  it('runs a one-shot build beside the process on its existing path', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const oneShot: string[][] = [];
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => { if (args.includes('new-session')) { oneShot.push(args); return { code: 0, stdout: '' }; } return await tmux.command(binary, args); });
    await expect(service.start(cora.id, 'build')).resolves.toBe('started');
    expect(oneShot[0]?.[oneShot[0].indexOf('-s') + 1]).toMatch(/^rac-stack-proj-[0-9a-f]{12}-.+-exclusive$/u);
    expect(oneShot[0]?.at(-1)).toContain('pnpm build');
  });
});

describe('worktree setup command', () => {
  type FakeCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  const fastTiming = { timeoutMs: 2_000, pollMs: 10 };
  // a fake host tmux that runs the setup script by writing its exit marker through the mount,
  // like the concurrency/status tests: the host path maps to the console-side checkout
  const runningSetup = (exit: string) => {
    const launched: string[] = [];
    const scripts: string[] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (!args.includes('new-session')) return { code: 1, stdout: '' };
      const script = args.at(-1) ?? '';
      launched.push(args[args.indexOf('-s') + 1] ?? '');
      scripts.push(script);
      const hostMarker = /> '([^']+\.exit)'/u.exec(script)?.[1];
      if (hostMarker !== undefined) await writeFile(join(checkoutRoot!, hostMarker.slice('/host/checkout/'.length)), exit);
      return { code: 0, stdout: '' };
    };
    return { command, launched, scripts };
  };
  const setupService = (worktree: ReturnType<typeof testWorktree>, command: FakeCommand, timing = fastTiming) => {
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot!, hostPath: '/host/checkout' })] });
    return new WorktreeCommandService(projectConfig, { worktreesNow: () => [worktree] } as never, command, checkoutRoot!, timing);
  };

  it('runs the setup command in the worktree and reports success on a zero exit', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'pnpm install' } });
    const { command, launched, scripts } = runningSetup('0');
    const service = setupService(cora, command);
    const result = await service.runSetup(cora);
    // a successful run reports ok and keeps no log
    expect(result).toEqual({ ok: true });
    // it runs in the worktree host root and captures output to a host-side log
    expect(launched[0]).toMatch(/^rac-setup-proj-[0-9a-f]{12}-[0-9a-f]{18}$/);
    expect(scripts[0]).toContain("cd -- '/host/cora'");
    expect(scripts[0]).toContain("> '/host/checkout/.data/stack-logs/setup-");
    expect(scripts[0]).toContain('pnpm install');
  });

  it('reports failure on a non-zero setup exit', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'exit 1' } });
    const { command } = runningSetup('1');
    // a failed run keeps its log and points at it for host-side inspection
    const result = await setupService(cora, command).runSetup(cora);
    expect(result.ok).toBe(false);
    expect(result.log).toContain('/.data/stack-logs/setup-');
  });

  it('is a no-op success when no setup command is configured', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { build: 'make' } });
    let sessions = 0;
    const service = setupService(cora, async (_binary, args) => { if (args.includes('new-session')) sessions += 1; return { code: 1, stdout: '' }; });
    await expect(service.runSetup(cora)).resolves.toEqual({ ok: true });
    expect(sessions).toBe(0);
  });

  it("runs the setup command on tmux's default socket in native mode", async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    // a native worktree has no separate host path: the console and tmux share a filesystem
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { setup: 'pnpm install' } });
    const launches: string[][] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (!args.includes('new-session')) return { code: 1, stdout: '' };
      launches.push(args);
      // native mode writes the marker to a real console-side path, not a mounted host path
      const marker = /> '([^']+\.exit)'/u.exec(args.at(-1) ?? '')?.[1];
      if (marker !== undefined) await writeFile(marker, '0');
      return { code: 0, stdout: '' };
    };
    await expect(setupService(cora, command).runSetup(cora)).resolves.toEqual({ ok: true });
    // it launched once, on the default socket (no '-S'), and ran in the worktree
    expect(launches).toHaveLength(1);
    expect(launches[0]!.includes('-S')).toBe(false);
    expect(launches[0]!.at(-1)).toContain("cd -- '/worktrees/cora'");
  });

  it('reports failure when the setup command never finishes within the budget', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'sleep 999' } });
    // it launches but never writes a marker, so the bounded poll gives up
    const service = setupService(cora, async () => ({ code: 0, stdout: '' }), { timeoutMs: 120, pollMs: 10 });
    await expect(service.runSetup(cora)).resolves.toMatchObject({ ok: false });
  });

  it('kills a setup session that never finishes, so it cannot linger on the tmux server', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'sleep 999' } });
    const created: string[] = [];
    const killed: string[] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (args.includes('new-session')) { created.push(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
      if (args.includes('kill-session')) { killed.push((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')); return { code: 0, stdout: '' }; }
      return { code: 1, stdout: '' };
    };
    // it launches but never writes a marker; when the bounded poll gives up the session is killed
    const service = setupService(cora, command, { timeoutMs: 120, pollMs: 10 });
    await expect(service.runSetup(cora)).resolves.toMatchObject({ ok: false });
    expect(created).toHaveLength(1);
    expect(killed).toEqual(created);
  });
});
