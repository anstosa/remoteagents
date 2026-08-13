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
});
