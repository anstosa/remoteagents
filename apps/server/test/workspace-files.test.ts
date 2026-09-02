import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileMentions, WorkspaceFileService } from '../src/workspace-files/service.js';

describe('workspace response files', () => {
  it('extracts explicit and bare file references without remote URLs', () => {
    const message = 'Changed `src/main.ts:42`, [setup](docs/setup.md), and src/main.ts. See https://example.com/docs/help.';
    expect(fileMentions(message)).toEqual(['src/main.ts', 'docs/setup.md']);
  });

  it('lists only real contained files and blocks symlink escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-response-files-'));
    const workspace = join(directory, 'workspace');
    const outside = join(directory, 'outside.txt');
    try {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src/main.ts'), 'export const ready = true;\n');
      await writeFile(join(workspace, 'README.md'), '# Ready\n');
      await writeFile(outside, 'secret');
      await symlink(outside, join(workspace, 'src/escaped.txt'));
      const service = new WorkspaceFileService();
      const message = '`src/main.ts:7` [readme](README.md) `src/escaped.txt` `../outside.txt` `missing.ts`';

      await expect(service.list(workspace, message)).resolves.toEqual([
        { path: 'src/main.ts', size: 27 },
        { path: 'README.md', size: 8 }
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('returns bounded text previews and identifies binary files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-response-preview-'));
    try {
      await writeFile(join(workspace, 'large.txt'), 'x'.repeat(256 * 1_024 + 10));
      await writeFile(join(workspace, 'binary.dat'), Buffer.from([1, 0, 2]));
      const service = new WorkspaceFileService();

      await expect(service.preview(workspace, 'large.txt')).resolves.toMatchObject({ path: 'large.txt', binary: false, truncated: true, content: 'x'.repeat(256 * 1_024) });
      await expect(service.preview(workspace, 'binary.dat')).resolves.toEqual({ path: 'binary.dat', size: 3, binary: true, truncated: false });
      await expect(service.preview(workspace, '../unavailable.txt')).resolves.toBeUndefined();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  // verify host temporary screenshots stay image-only and pane-scoped
  it('previews bounded host temporary images through the selected pane root', async () => {
    const procRoot = await mkdtemp(join(tmpdir(), 'rac-host-proc-'));
    const invalidProcRoot = await mkdtemp(join(tmpdir(), 'rac-empty-proc-'));
    const pid = '1234';
    const otherPid = '5678';
    const hostTmp = join(procRoot, pid, 'root', 'tmp');
    const otherHostTmp = join(procRoot, otherPid, 'root', 'tmp');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    try {
      await mkdir(hostTmp, { recursive: true });
      await mkdir(otherHostTmp, { recursive: true });
      await writeFile(join(hostTmp, 'agent-screenshot.png'), png);
      await writeFile(join(otherHostTmp, 'agent-screenshot.png'), jpeg);
      await writeFile(join(hostTmp, 'not-an-image.png'), 'private text');
      await symlink(join(hostTmp, 'agent-screenshot.png'), join(hostTmp, 'linked.png'));
      const service = new WorkspaceFileService({ hostProcRoot: procRoot, hostUid: process.getuid() });

      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).resolves.toEqual({
        path: '/tmp/agent-screenshot.png',
        size: png.length,
        binary: true,
        truncated: false,
        image: { mediaType: 'image/png', base64: png.toString('base64') }
      });
      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png', Number(otherPid))).resolves.toMatchObject({ image: { mediaType: 'image/jpeg' } });
      await expect(service.previewTemporaryImage('/tmp/not-an-image.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/linked.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/nested/agent-screenshot.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/etc/agent-screenshot.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png')).resolves.toBeUndefined();
      const unavailable = new WorkspaceFileService({ hostProcRoot: join(procRoot, 'missing'), hostUid: process.getuid() });
      await expect(unavailable.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).rejects.toMatchObject({ statusCode: 503 });
      const invalid = new WorkspaceFileService({ hostProcRoot: invalidProcRoot, hostUid: process.getuid() });
      await expect(invalid.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      await Promise.all([
        rm(procRoot, { recursive: true, force: true }),
        rm(invalidProcRoot, { recursive: true, force: true })
      ]);
    }
  });
});
