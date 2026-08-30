import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAgentCommand, isHudWatcherCommand, ProcInspector } from '../src/discovery/processes.js';

describe('isAgentCommand', () => {
  it('recognizes the Node launcher used by current Codex installations', () => {
    expect(isAgentCommand('MainThread', 'node\0/home/ubuntu/n/bin/codex\0')).toBe(true);
  });

  it('does not treat unrelated Node processes as agents', () => {
    expect(isAgentCommand('node', 'node\0/app/server.js\0')).toBe(false);
  });

  it('does not treat an OMX HUD process as an agent', () => {
    expect(isAgentCommand('MainThread', 'node\0/home/ubuntu/n/bin/omx\0hud\0--watch\0')).toBe(false);
  });
});

describe('isHudWatcherCommand', () => {
  it('recognizes direct and Node-launched OMX HUD watchers only', () => {
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0--watch\0')).toBe(true);
    expect(isHudWatcherCommand(['node', '/home/ubuntu/bin/omx', 'hud', '--interval', '1', '--watch', ''].join('\0'))).toBe(true);
    expect(isHudWatcherCommand('/home/ubuntu/bin/omx\0hud\0')).toBe(false);
    expect(isHudWatcherCommand('node\0/app/server.js\0--watch\0')).toBe(false);
  });
});

describe('ProcInspector recognizeAgent', () => {
  // build a fake /proc tree: comm, cmdline and children per pid
  const buildTree = async (root: string, tree: Record<number, { comm: string; argv: string[]; children: number[] }>) => {
    await Promise.all(Object.entries(tree).map(async ([pid, node]) => {
      await mkdir(join(root, pid, 'task', pid), { recursive: true });
      await Promise.all([
        writeFile(join(root, pid, 'comm'), `${node.comm}\n`),
        writeFile(join(root, pid, 'cmdline'), `${node.argv.join('\0')}\0`),
        writeFile(join(root, pid, 'task', pid, 'children'), `${node.children.join(' ')}\n`)
      ]);
    }));
  };
  const withProcTree = async (tree: Record<number, { comm: string; argv: string[]; children: number[] }>, run: () => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'rac-recognize-'));
    const previous = process.env.RAC_HOST_PROC;
    process.env.RAC_HOST_PROC = root;
    try {
      await buildTree(root, tree);
      await run();
    } finally {
      if (previous === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous;
      await rm(root, { recursive: true, force: true });
    }
  };

  it('finds a codex descendant beneath a bwrap wrapper and flags it wrapped', async () => {
    await withProcTree({
      200: { comm: 'bash', argv: ['bash'], children: [201] },
      201: { comm: 'bwrap', argv: ['bwrap', '--', 'codex'], children: [202] },
      202: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(200)).resolves.toEqual({ kind: 'codex', pid: 202, wrapped: true });
    });
  });

  it('recognizes an unwrapped codex descendant without the wrapped flag', async () => {
    await withProcTree({
      300: { comm: 'bash', argv: ['bash'], children: [301] },
      301: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(300)).resolves.toEqual({ kind: 'codex', pid: 301, wrapped: false });
    });
  });

  it('does not flag an agent wrapped when a bwrap sits only in a sibling branch', async () => {
    await withProcTree({
      500: { comm: 'bash', argv: ['bash'], children: [501, 503] },
      501: { comm: 'bwrap', argv: ['bwrap', '--', 'vim'], children: [502] },
      502: { comm: 'vim', argv: ['vim'], children: [] },
      503: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(500)).resolves.toEqual({ kind: 'codex', pid: 503, wrapped: false });
    });
  });

  it('returns undefined when no registered agent runs in the tree', async () => {
    await withProcTree({
      400: { comm: 'bash', argv: ['bash'], children: [401] },
      401: { comm: 'vim', argv: ['vim'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(400)).resolves.toBeUndefined();
    });
  });
});

describe('ProcInspector sessions', () => {
  it('reads exact rollout identities from one pane process tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = process.env.RAC_HOST_PROC;
    process.env.RAC_HOST_PROC = root;
    try {
      await Promise.all([
        mkdir(join(root, '100', 'task', '100'), { recursive: true }),
        mkdir(join(root, '100', 'fd'), { recursive: true }),
        mkdir(join(root, '101', 'task', '101'), { recursive: true }),
        mkdir(join(root, '101', 'fd'), { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(root, '100', 'task', '100', 'children'), '101\n'),
        writeFile(join(root, '101', 'task', '101', 'children'), ''),
        symlink('/home/ubuntu/.codex/sessions/2026/08/21/rollout-2026-08-21T06-00-00-0198c333-3333-7333-8333-333333333333.jsonl', join(root, '101', 'fd', '42')),
        symlink('/tmp/unrelated.txt', join(root, '101', 'fd', '43'))
      ]);

      await expect(new ProcInspector().sessionsForDescendants(100)).resolves.toEqual([{ id: '0198c333-3333-7333-8333-333333333333', relativePath: 'sessions/2026/08/21/rollout-2026-08-21T06-00-00-0198c333-3333-7333-8333-333333333333.jsonl' }]);
    } finally {
      // restore process inspection state
      if (previous === undefined) delete process.env.RAC_HOST_PROC;
      else process.env.RAC_HOST_PROC = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
