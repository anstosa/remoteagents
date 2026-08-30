// Command catalog scanner tests. (Named `skills.test.ts` for continuity — the
// deletion hook blocks a rename; the subject is now CommandCatalogService, which
// superseded the old SkillService.)
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandCatalogService } from '../src/commands/service.js';
import { codexAdapter } from '../src/adapters/codex.js';

const roots: string[] = [];

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeSkill(base: string, directory: string, contents: string) {
  const path = join(base, '.codex', 'skills', directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), contents);
  return path;
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('command catalog', () => {
  it('scans the account home and workspace, follows symlinked skills, and appends the slash list', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'release-notes', skill('release-notes', 'Draft release notes for this repository.'));
    await writeSkill(workspace, 'push', skill('push', 'Review, commit, and push the current branch.'));
    // a symlinked skill directory is followed, not skipped
    const target = join(await tempRoot('rac-linked-'), 'linked');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill('linked', 'A symlinked skill.'));
    await symlink(target, join(workspace, '.codex', 'skills', 'linked'));

    const catalog = await new CommandCatalogService().catalog(codexAdapter, workspace, home);

    expect(catalog.filter(command => command.value.startsWith('$'))).toEqual([
      { value: '$linked', description: 'A symlinked skill.' },
      { value: '$push', description: 'Review, commit, and push the current branch.' },
      { value: '$release-notes', description: 'Draft release notes for this repository.' }
    ]);
    expect(catalog.find(command => command.value === '/help')).toEqual({ value: '/help', description: 'Show available commands' });
    // the slash list follows the skills
    expect(catalog.findIndex(command => command.value === '/help')).toBeGreaterThan(catalog.findIndex(command => command.value === '$push'));
  });

  it('lets a workspace skill shadow the same-named account skill', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'push', skill('push', 'Global push.'));
    await writeSkill(workspace, 'push', skill('push', 'Workspace push.'));

    const catalog = await new CommandCatalogService().catalog(codexAdapter, workspace, home);

    expect(catalog.find(command => command.value === '$push')).toEqual({ value: '$push', description: 'Workspace push.' });
  });

  it('tolerates a zero-byte file where a skills root should be', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'release-notes', skill('release-notes', 'Draft release notes.'));
    // the workspace skills root is a zero-byte file, not a directory
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(join(workspace, '.codex', 'skills'), '');

    const catalog = await new CommandCatalogService().catalog(codexAdapter, workspace, home);

    expect(catalog.filter(command => command.value.startsWith('$'))).toEqual([{ value: '$release-notes', description: 'Draft release notes.' }]);
  });

  it('ignores malformed metadata and unavailable roots', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(workspace, 'missing-description', `---\nname: missing-description\n---\n`);
    await writeSkill(workspace, 'invalid-name', skill('not a command', 'Invalid.'));

    const catalog = await new CommandCatalogService().catalog(codexAdapter, workspace, home);

    expect(catalog.some(command => command.value.startsWith('$'))).toBe(false);
  });
});
