import { afterEach, describe, expect, it, vi } from 'vitest';
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
      if (!args.includes('new-session')) return { code: 1, stdout: '' };
      const hostFile = /> '(\/host\/checkout\/[^']+)'/u.exec(args.at(-1) ?? '')?.[1];
      if (hostFile === undefined) return { code: 1, stdout: '' };
      statusFiles.push(hostFile);
      await writeFile(join(checkoutRoot!, hostFile.slice('/host/checkout/'.length)), hostFile.includes(worktreeToken('proj', cora.path)) ? '0' : '1');
      return { code: 0, stdout: '' };
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
});
