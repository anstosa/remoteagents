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
