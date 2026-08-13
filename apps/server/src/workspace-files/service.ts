import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceFileSummary = { path: string; size: number };
export type WorkspaceFilePreview = WorkspaceFileSummary & { binary: boolean; truncated: boolean; content?: string };

const maxMessageLength = 30_000;
const maxCandidates = 24;
const maxPathLength = 512;
const maxPreviewBytes = 256 * 1024;
const knownBasenames = /^(?:README|LICENSE|Dockerfile|Makefile)(?:\.[A-Za-z0-9_-]+)?$/u;

// normalize one mentioned path
const normalizeMention = (value: string): string | undefined => {
  let path = value.trim().replace(/^file:\/\//u, '').replace(/^@/u, '').replace(/^['"`(<]+|['"`>),.;]+$/gu, '');
  try { path = decodeURIComponent(path); } catch { return undefined; }
  path = path.replace(/#L\d+(?:-L\d+)?$/iu, '').replace(/:\d+(?::\d+)?$/u, '');
  if (!path || path.length > maxPathLength || path.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) return undefined;
  return path;
};

// recognize likely file references
const looksLikePath = (value: string) => value.includes('/') || /^[^\s/]+\.[A-Za-z0-9_-]{1,16}(?::\d+(?::\d+)?)?$/u.test(value) || knownBasenames.test(value);

// extract bounded path candidates
export const fileMentions = (message: string): string[] => {
  if (!message || message.length > maxMessageLength || message.includes('\0')) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // retain explicit Markdown and code references
  for (const match of message.matchAll(/`([^`\n]+)`|\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const candidate = normalizeMention(match[1] ?? match[2] ?? '');
    if (candidate !== undefined && looksLikePath(candidate) && !seen.has(candidate)) { seen.add(candidate); found.push(candidate); }
  }
  // retain bare paths with directory segments
  for (const match of message.matchAll(/(?:^|[\s'"(])((?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)/gmu)) {
    const candidate = normalizeMention(match[1] ?? '');
    if (candidate !== undefined && !seen.has(candidate)) { seen.add(candidate); found.push(candidate); }
  }
  return found.slice(0, maxCandidates);
};

// keep resolved files inside one workspace
const resolveFile = async (workspace: string, mention: string): Promise<{ root: string; file: string; summary: WorkspaceFileSummary } | undefined> => {
  const path = normalizeMention(mention);
  if (path === undefined) return undefined;
  const root = await realpath(workspace).catch(() => undefined);
  if (root === undefined) return undefined;
  const file = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => undefined);
  if (file === undefined) return undefined;
  const local = relative(root, file);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  return { root, file, summary: { path: local.split(sep).join('/'), size: info.size } };
};

export class WorkspaceFileService {
  // list real files mentioned by one response
  async list(workspace: string, message: string): Promise<WorkspaceFileSummary[]> {
    const files: WorkspaceFileSummary[] = [];
    const seen = new Set<string>();
    // resolve candidates sequentially within fixed bounds
    for (const mention of fileMentions(message)) {
      const resolved = await resolveFile(workspace, mention);
      if (resolved !== undefined && !seen.has(resolved.summary.path)) { seen.add(resolved.summary.path); files.push(resolved.summary); }
    }
    return files;
  }

  // load a bounded text preview
  async preview(workspace: string, path: string): Promise<WorkspaceFilePreview | undefined> {
    const resolved = await resolveFile(workspace, path);
    if (resolved === undefined) return undefined;
    const handle = await open(resolved.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const [info, opened] = await Promise.all([handle.stat(), realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined)]);
      // bind containment and size checks to the opened descriptor
      if (!info.isFile() || opened === undefined) return undefined;
      const local = relative(resolved.root, opened);
      if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
      const summary = { path: local.split(sep).join('/'), size: info.size };
      const length = Math.min(summary.size, maxPreviewBytes);
      const bytes = Buffer.alloc(length);
      const read = length === 0 ? 0 : (await handle.read(bytes, 0, length, 0)).bytesRead;
      const content = bytes.subarray(0, read);
      const binary = content.includes(0);
      return { ...summary, binary, truncated: summary.size > read, ...(binary ? {} : { content: content.toString('utf8') }) };
    } finally { await handle.close(); }
  }
}
