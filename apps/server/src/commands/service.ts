import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';

/**
 * The prompt-box command catalog, served per Agent from the Adapter (ADR 0002).
 * The web no longer carries hard-coded `$skill`/`/slash` arrays: the console
 * scans the Adapter's skill directories on disk, invokes each as the Adapter
 * says (`$name` for Codex), and appends the Adapter's curated slash list. The
 * scanner `stat`s symlinked entries — Codex and Claude skills are commonly
 * symlinks — and tolerates a zero-byte file sitting where a skills root should
 * be.
 */

export type CatalogCommand = { value: string; description?: string };
type SkillSummary = { name: string; description: string };

const skillName = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const maxSkillFileBytes = 128 * 1024;
const maxSkillsPerRoot = 256;
// bound the entries `stat`ed per root so a directory full of (broken) symlinks cannot amplify one request
const maxEntriesPerRoot = 4_096;

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

// read one skill manifest, ignoring oversized or non-file entries
async function readSkill(path: string): Promise<SkillSummary | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxSkillFileBytes) return undefined;
    return metadata(await readFile(path, 'utf8'));
  } catch { return undefined; }
}

// treat a directory, or a symlink resolving to one, as a skill entry
async function isSkillDirectory(root: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return await stat(join(root, entry.name)).then(info => info.isDirectory()).catch(() => false);
}

// scan one skills root, tolerating a zero-byte file where the root should be
async function scanRoot(root: string): Promise<SkillSummary[]> {
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maxEntriesPerRoot);
  const directories: string[] = [];
  for (const entry of entries) {
    if (directories.length >= maxSkillsPerRoot) break;
    if (await isSkillDirectory(root, entry)) directories.push(entry.name);
  }
  const discovered = await Promise.all(directories.map(name => readSkill(join(root, name, 'SKILL.md'))));
  return discovered.filter((skill): skill is SkillSummary => skill !== undefined);
}

export class CommandCatalogService {
  // build the prompt-box catalog for one Agent's kind
  async catalog(adapter: Adapter, workspace: string, home: string): Promise<CatalogCommand[]> {
    const commands = adapter.commands;
    if (commands === undefined) return [];
    const byName = new Map<string, SkillSummary>();
    // later roots (the workspace) override earlier ones (the account home)
    for (const root of commands.skillDirectories(workspace, home)) {
      for (const skill of await scanRoot(root)) byName.set(skill.name, skill);
    }
    const skills = [...byName.values()]
      .map(skill => ({ value: commands.skillInvocation(skill.name), description: skill.description }))
      .sort((left, right) => left.value.localeCompare(right.value));
    const slash = commands.slash.map(command => ({ value: command.name, description: command.description }));
    return [...skills, ...slash];
  }
}
