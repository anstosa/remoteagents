import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../src/skills/service.js';

const roots: string[] = [];

async function skillRoot() {
  const root = await mkdtemp(join(tmpdir(), 'rac-skills-'));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, directory: string, contents: string) {
  const path = join(root, '.codex', 'skills', directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), contents);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('project skill discovery', () => {
  it('returns valid repo-local skills in display order', async () => {
    const root = await skillRoot();
    await writeSkill(root, 'push', `---\nname: push\ndescription: Review, commit, and push the current branch.\n---\n`);
    await writeSkill(root, 'release-notes', `---\nname: release-notes\ndescription: "Draft release notes for this repository."\n---\n`);

    await expect(new SkillService().list(root)).resolves.toEqual([
      { name: 'push', description: 'Review, commit, and push the current branch.' },
      { name: 'release-notes', description: 'Draft release notes for this repository.' }
    ]);
  });

  it('ignores malformed metadata and unavailable skill roots', async () => {
    const root = await skillRoot();
    await writeSkill(root, 'missing-description', `---\nname: missing-description\n---\n`);
    await writeSkill(root, 'invalid-name', `---\nname: not a command\ndescription: Invalid.\n---\n`);

    await expect(new SkillService().list(root)).resolves.toEqual([]);
    await expect(new SkillService().list(join(root, 'missing'))).resolves.toEqual([]);
  });
});
