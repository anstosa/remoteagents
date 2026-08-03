import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type SkillSummary = { name: string; description: string };

const skillName = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const maxSkillFileBytes = 128 * 1024;
const maxSkills = 256;

function scalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === 'string' ? parsed : undefined;
    } catch { return undefined; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function metadata(contents: string): SkillSummary | undefined {
  const lines = contents.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.slice(1).findIndex(line => line.trim() === '---');
  if (end < 0) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end + 1)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  const name = scalar(fields.get('name') ?? '');
  const description = scalar(fields.get('description') ?? '');
  if (!name || !description || !skillName.test(name)) return undefined;
  return { name, description: description.replace(/\s+/gu, ' ').slice(0, 500) };
}

async function readSkill(path: string): Promise<SkillSummary | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxSkillFileBytes) return undefined;
    return metadata(await readFile(path, 'utf8'));
  } catch { return undefined; }
}

export class SkillService {
  async list(workspace: string): Promise<SkillSummary[]> {
    const root = join(workspace, '.codex', 'skills');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const discovered = await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, maxSkills)
      .map(entry => readSkill(join(root, entry.name, 'SKILL.md'))));
    return discovered.filter((skill): skill is SkillSummary => skill !== undefined).sort((left, right) => left.name.localeCompare(right.name));
  }
}
