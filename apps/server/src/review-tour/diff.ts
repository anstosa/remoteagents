import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { classifyReviewPath } from '../git/change-classification.js';
import { gitComparisonSummary, gitStatusSummary } from '../discovery/service.js';
import { run } from '../tmux/command.js';
import type { GitStatusChange } from '../domain/models.js';
import type { ResolvedWorkspace } from '../workspaces/resolver.js';
import { MAX_REVIEW_CHANGES, MAX_REVIEW_DIFF_BYTES, MAX_REVIEW_FILES, MAX_REVIEW_FILE_BYTES, ReviewTourError, type ReviewChange, type ReviewChangeKind, type ReviewSnapshot, type ReviewTourInput } from './contracts.js';

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// hash trusted review values
function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// capture a bounded untracked patch
async function untrackedPatch(workspace: string, change: GitStatusChange): Promise<{ patch: string; kind: ReviewChangeKind }> {
  const path = join(workspace, change.path);
  const info = await lstat(path).catch(() => undefined);
  // reject disappearing or unsupported paths
  if (info === undefined) return { patch: `untracked file ${change.path} disappeared`, kind: 'metadata' };
  // represent symlinks without following them
  if (info.isSymbolicLink()) {
    const target = await readlink(path).catch(() => 'unavailable');
    return { patch: `new symlink ${change.path} -> ${target}`, kind: 'metadata' };
  }
  // represent non-files as metadata
  if (!info.isFile()) return { patch: `untracked non-file ${change.path}`, kind: 'metadata' };
  const root = await realpath(workspace).catch(() => undefined);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  // reject files replaced during inspection
  if (root === undefined || handle === undefined) return { patch: `untracked file ${change.path} disappeared`, kind: 'metadata' };
  let content: Buffer;
  try {
    const [opened, openedInfo] = await Promise.all([realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined), handle.stat()]);
    const local = opened === undefined ? undefined : relative(root, opened);
    // bind containment and size checks to the opened descriptor
    if (opened === undefined || local === undefined || !local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !openedInfo.isFile()) return { patch: `untracked file ${change.path} changed during capture`, kind: 'metadata' };
    if (openedInfo.size > MAX_REVIEW_FILE_BYTES) throw new ReviewTourError('too_large', false);
    const bounded = Buffer.alloc(MAX_REVIEW_FILE_BYTES + 1);
    const read = await handle.read(bounded, 0, bounded.length, 0);
    // reject files that grew beyond the validated limit
    if (read.bytesRead > MAX_REVIEW_FILE_BYTES) throw new ReviewTourError('too_large', false);
    content = bounded.subarray(0, read.bytesRead);
  } finally { await handle.close(); }
  // represent binary data without exposing bytes
  if (content.subarray(0, 8_000).includes(0)) return { patch: `new binary file ${change.path} (${content.length} bytes)`, kind: 'binary' };
  const text = content.toString('utf8');
  const lines = text === '' ? [] : text.split('\n');
  const additions = lines.length - (text.endsWith('\n') ? 1 : 0);
  const body = lines.slice(0, additions).map(line => `+${line}`).join('\n');
  return { patch: `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${additions} @@\n${body}${body === '' ? '' : '\n'}`, kind: 'untracked' };
}

// split one file patch into trusted atomic units
function atomicPatches(patch: string, fallbackKind: ReviewChangeKind): Array<{ patch: string; kind: ReviewChangeKind; oldStart?: number; oldLines?: number; newStart?: number; newLines?: number }> {
  const lines = patch.split('\n');
  const hunks: Array<{ index: number; oldStart: number; oldLines: number; newStart: number; newLines: number }> = [];
  // find unified hunk headers
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]!);
    // collect valid ranges
    if (match !== null) hunks.push({ index, oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) });
  }
  // retain metadata-only changes
  if (hunks.length === 0) return [{ patch, kind: fallbackKind }];
  const header = lines.slice(0, hunks[0]!.index).join('\n');
  // attach the shared file header to each hunk
  return hunks.map((hunk, index) => {
    const end = hunks[index + 1]?.index ?? lines.length;
    const body = lines.slice(hunk.index, end).join('\n');
    return { patch: `${header}\n${body}`, kind: 'hunk' as const, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines };
  });
}

// capture tracked patch content
async function trackedPatch(workspace: string, base: string, change: GitStatusChange): Promise<string> {
  const paths = [change.originalPath, change.path].filter((path): path is string => path !== undefined);
  const result = await run('/usr/bin/git', ['--no-optional-locks', '-C', workspace, 'diff', '--binary', '--no-ext-diff', '--no-color', '--unified=3', '--find-renames', base, '--', ...paths], undefined, 20_000);
  // surface Git failures as unavailable scope
  if (result.code !== 0) throw new ReviewTourError('scope_unavailable', true);
  return result.stdout || `${change.code.trim() || 'metadata'} ${change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}`;
}

// resolve a fresh comparison summary
async function comparison(resolved: ResolvedWorkspace, input: ReviewTourInput): Promise<{ base: string; gitBase: string; changes: GitStatusChange[] }> {
  const status = await run('/usr/bin/git', ['--no-optional-locks', '-C', resolved.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  // require a readable repository
  if (status.code !== 0) throw new ReviewTourError('scope_unavailable', true);
  const working = gitStatusSummary(status.stdout);
  // block conflicted snapshots
  if (working.changes?.some(change => conflictCodes.has(change.code))) throw new ReviewTourError('conflicted_unavailable', true);
  // capture working changes from HEAD
  if (input.scope === 'working') {
    const head = await run('/usr/bin/git', ['-C', resolved.workspace, 'rev-parse', '--verify', 'HEAD']);
    const gitBase = head.code === 0 ? head.stdout.trim() : emptyTree;
    return { base: head.code === 0 ? 'HEAD' : 'empty tree', gitBase, changes: working.changes ?? [] };
  }
  const preferred = resolved.agent.gitPrStatus?.base;
  // require the dashboard merge target
  if (preferred === undefined) throw new ReviewTourError('scope_unavailable', true);
  const mergeBase = await run('/usr/bin/git', ['-C', resolved.workspace, 'merge-base', 'HEAD', preferred]);
  // require a current merge base
  if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') throw new ReviewTourError('scope_unavailable', true);
  const gitBase = mergeBase.stdout.trim();
  const [names, lines] = await Promise.all([
    run('/usr/bin/git', ['--no-optional-locks', '-C', resolved.workspace, 'diff', '--name-status', '-z', '--find-renames', gitBase, '--']),
    run('/usr/bin/git', ['--no-optional-locks', '-C', resolved.workspace, 'diff', '--numstat', '-z', gitBase, '--'])
  ]);
  // require both PR comparison views
  if (names.code !== 0 || lines.code !== 0) throw new ReviewTourError('scope_unavailable', true);
  const untracked = working.changes?.filter(change => change.code === '??') ?? [];
  return { base: preferred, gitBase, changes: gitComparisonSummary(preferred, names.stdout, lines.stdout, untracked).changes ?? [] };
}

// capture a canonical review snapshot
export async function captureReviewSnapshot(resolved: ResolvedWorkspace, input: ReviewTourInput): Promise<ReviewSnapshot> {
  const current = await comparison(resolved, input);
  const selected = current.changes.filter(change => {
    const category = classifyReviewPath(change.path);
    // apply independent support filters
    return category === 'implementation' || category === 'test' && input.includeTests || category === 'doc' && input.includeDocs;
  });
  // enforce selected file limits
  if (selected.length > MAX_REVIEW_FILES) throw new ReviewTourError('too_large', false);
  const changes: ReviewChange[] = [];
  let bytes = 0;
  // capture every selected file
  for (const change of selected) {
    const category = classifyReviewPath(change.path);
    const captured = change.code === '??' ? await untrackedPatch(resolved.workspace, change) : { patch: await trackedPatch(resolved.workspace, current.gitBase, change), kind: change.code.trim().startsWith('R') ? 'rename' as const : 'metadata' as const };
    const units = atomicPatches(captured.patch, captured.kind);
    // capture every atomic unit
    for (const unit of units) {
      const unitBytes = Buffer.byteLength(unit.patch);
      // enforce the stored change limit after hunk splitting
      if (unitBytes > MAX_REVIEW_FILE_BYTES) throw new ReviewTourError('too_large', false);
      bytes += unitBytes;
      // enforce aggregate limits
      if (bytes > MAX_REVIEW_DIFF_BYTES || changes.length >= MAX_REVIEW_CHANGES) throw new ReviewTourError('too_large', false);
      const key = JSON.stringify([change.path, change.originalPath, category, unit.kind, unit.patch]);
      changes.push({ id: `chg_${digest(key).slice(0, 28)}`, file: change.path, ...(change.originalPath === undefined ? {} : { originalFile: change.originalPath }), category, kind: unit.kind, ...(unit.oldStart === undefined ? {} : { oldStart: unit.oldStart, oldLines: unit.oldLines, newStart: unit.newStart, newLines: unit.newLines }), patch: unit.patch });
    }
  }
  const fingerprint = digest(JSON.stringify({ scope: input.scope, base: current.base, gitBase: current.gitBase, includeTests: input.includeTests, includeDocs: input.includeDocs, changes }));
  return { agentId: resolved.agent.id, worktreeId: resolved.worktree.id, workspace: resolved.workspace, ...(resolved.agent.branch === undefined ? {} : { branch: resolved.agent.branch }), scope: input.scope, base: current.base, includeTests: input.includeTests, includeDocs: input.includeDocs, fingerprint, changes };
}
