import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { run, safeEnv } from '../tmux/command.js';
import { classifyReviewPath } from './change-classification.js';
import { WorkspaceFileService } from '../workspace-files/service.js';
import type { GitComparisonSummary, GitStatusChange, GitStatusSummary } from '../domain/models.js';

// One place for the git comparison pipeline: the base-candidate / merge-base ladder, the
// porcelain status + name-status + numstat sequence, the pure parsers, untracked-patch
// synthesis, per-file patch capture, a file-at-revision helper, and a content-sensitive
// Comparison fingerprint. Both the dashboard's change summaries (discovery) and the Review
// tour read from here; the base of a Comparison is always a parameter.

const git = '/usr/bin/git';
// git's canonical empty-tree object; the base of a Working Comparison with no HEAD yet
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// hash a trusted value into a compact, stable token
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// ---- Pure parsers -------------------------------------------------------------------------

type GitLineStats = { additions: number; deletions: number };
function gitNumstat(output: string): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = Number(record.slice(0, firstTab));
    const deletions = Number(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1;
      path = records[++index] ?? '';
    }
    if (!path || !Number.isInteger(additions) || !Number.isInteger(deletions)) continue;
    const current = stats.get(path);
    stats.set(path, { additions: (current?.additions ?? 0) + additions, deletions: (current?.deletions ?? 0) + deletions });
  }
  return stats;
}

export function gitStatusSummary(output: string, numstatOutputs: string[] = []): GitStatusSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = output.includes('\0');
  const records = output.split(nulDelimited ? '\0' : '\n');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    let path = record.slice(3);
    let originalPath: string | undefined;
    if (code[0] === 'R' || code[0] === 'C') {
      if (nulDelimited) originalPath = records[++index] || undefined;
      else {
        const separator = path.indexOf(' -> ');
        if (separator >= 0) {
          originalPath = path.slice(0, separator);
          path = path.slice(separator + 4);
        }
      }
    }
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = numstatOutputs.reduce((combined, numstat) => {
    for (const [path, stats] of gitNumstat(numstat)) {
      const current = combined.get(path);
      combined.set(path, { additions: (current?.additions ?? 0) + stats.additions, deletions: (current?.deletions ?? 0) + stats.deletions });
    }
    return combined;
  }, new Map<string, GitLineStats>());
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const summary: GitStatusSummary = { files: changes.length, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes };
  for (const { code } of changes) {
    if (code === '??') { summary.untracked += 1; continue; }
    if (conflictCodes.has(code)) { summary.conflicted += 1; continue; }
    if (code[0] !== ' ') summary.staged += 1;
    if (code[1] !== ' ') summary.unstaged += 1;
  }
  return summary;
}

// summarize changes from a merge base
export function gitComparisonSummary(base: string, nameStatusOutput: string, numstatOutput: string, untrackedChanges: GitStatusChange[] = []): GitComparisonSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = nameStatusOutput.includes('\0');
  const records = nameStatusOutput.split(nulDelimited ? '\0' : '\n');
  // parse name-status records
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // skip empty records
    if (!record) continue;
    let status: string;
    let path: string;
    let originalPath: string | undefined;
    // parse nul-delimited output
    if (nulDelimited) {
      status = record;
      path = records[++index] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = records[++index] ?? '';
      }
    } else {
      const parts = record.split('\t');
      status = parts[0] ?? '';
      path = parts[1] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = parts[2] ?? '';
      }
    }
    // ignore malformed records
    if (!status || !path) continue;
    const code = status[0] === 'U' ? 'UU' : `${status[0]} `;
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = gitNumstat(numstatOutput);
  // attach line totals
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const trackedPaths = new Set(changes.map(change => change.path));
  // include current untracked files
  for (const change of untrackedChanges) {
    // avoid duplicate paths
    if (!trackedPaths.has(change.path)) changes.push({ ...change });
  }
  return { base, files: changes.length, changes };
}

export async function addUntrackedLineStats(workspace: string, summary: GitStatusSummary, limits = { files: 256, bytes: 20 * 1024 * 1024, bytesPerFile: 5 * 1024 * 1024 }) {
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  for (const change of summary.changes ?? []) {
    if (change.code !== '??') continue;
    if (inspectedFiles >= limits.files || inspectedBytes >= limits.bytes) break;
    inspectedFiles += 1;
    try {
      const path = join(workspace, change.path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) { change.additions = 1; change.deletions = 0; continue; }
      if (!info.isFile() || info.size > limits.bytesPerFile || inspectedBytes + info.size > limits.bytes) continue;
      inspectedBytes += info.size;
      const handle = await open(path, 'r');
      const content = Buffer.allocUnsafe(info.size);
      let offset = 0;
      try {
        while (offset < content.length) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      const inspected = content.subarray(0, offset);
      if (inspected.subarray(0, 8_000).includes(0)) continue;
      let lines = 0;
      for (const byte of inspected) if (byte === 10) lines += 1;
      change.additions = lines + (inspected.length > 0 && inspected[inspected.length - 1] !== 10 ? 1 : 0);
      change.deletions = 0;
    } catch { /* The worktree may change between status and file inspection. */ }
  }
}

// ---- Base-candidate / merge-base ladder ---------------------------------------------------

// build the ordered base-branch candidates for an All PR Comparison; with `exactBase`, only the
// preferred base is tried, otherwise the configured merge base and origin fallbacks follow it
export async function prComparisonCandidates(workspace: string, branch: string | undefined, preferredBase?: string, exactBase = false): Promise<string[]> {
  const [configured, remoteHead] = await Promise.all([
    branch === undefined ? Promise.resolve({ code: 1, stdout: '' }) : run(git, ['-C', workspace, 'config', '--get', `branch.${branch}.gh-merge-base`]),
    run(git, ['-C', workspace, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  ]);
  const configuredBase = configured.code === 0 ? configured.stdout.trim() : '';
  const preferred = preferredBase === undefined ? undefined : preferredBase.startsWith('origin/') || preferredBase.startsWith('refs/') ? preferredBase : `origin/${preferredBase}`;
  return (exactBase ? [preferred] : [
    preferred,
    configuredBase === '' ? undefined : configuredBase.includes('/') ? configuredBase : `origin/${configuredBase}`,
    remoteHead.code === 0 ? remoteHead.stdout.trim() : undefined,
    'origin/main',
    'origin/master'
  ]).filter((candidate): candidate is string => candidate !== undefined && candidate !== '');
}

// try each candidate base against HEAD; the first whose merge base resolves yields the
// comparison summary (its `base` is the candidate label) and the merge-base sha (`gitBase`)
export async function comparisonAgainst(workspace: string, candidates: string[], untracked: GitStatusChange[] = []): Promise<{ comparison: GitComparisonSummary; gitBase: string } | undefined> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // skip duplicate fallbacks
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const mergeBase = await run(git, ['-C', workspace, 'merge-base', 'HEAD', candidate]);
    // skip unavailable targets
    if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') continue;
    const gitBase = mergeBase.stdout.trim();
    const [names, lines] = await Promise.all([
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--name-status', '-z', '--find-renames', gitBase, '--']),
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', gitBase, '--'])
    ]);
    // require both comparison views
    if (names.code !== 0 || lines.code !== 0) continue;
    return { comparison: gitComparisonSummary(candidate, names.stdout, lines.stdout, untracked), gitBase };
  }
  return undefined;
}

// ---- Working-tree status --------------------------------------------------------------------

// parse `git status --porcelain`; with `lineStats`, enrich additions/deletions from numstat
// (HEAD, falling back to the staged + unstaged passes when HEAD is unavailable)
export async function workingStatus(workspace: string, options: { lineStats?: boolean } = {}): Promise<GitStatusSummary | undefined> {
  if (options.lineStats !== true) {
    const status = await run(git, ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return status.code === 0 ? gitStatusSummary(status.stdout) : undefined;
  }
  const [status, diff] = await Promise.all([
    run(git, ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', 'HEAD', '--'])
  ]);
  if (status.code !== 0) return undefined;
  let numstatOutputs = diff.code === 0 ? [diff.stdout] : [];
  if (diff.code !== 0) {
    const [staged, unstaged] = await Promise.all([
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--cached', '--numstat', '-z', '--']),
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', '--'])
    ]);
    numstatOutputs = [staged, unstaged].filter(result => result.code === 0).map(result => result.stdout);
  }
  return gitStatusSummary(status.stdout, numstatOutputs);
}

// resolve HEAD as a Working Comparison base; a repository with no commit compares the empty tree
export async function resolveHead(workspace: string): Promise<{ base: string; gitBase: string }> {
  const head = await run(git, ['-C', workspace, 'rev-parse', '--verify', 'HEAD']);
  return head.code === 0 ? { base: 'HEAD', gitBase: head.stdout.trim() } : { base: 'empty tree', gitBase: emptyTree };
}

// ---- Comparison resolution ------------------------------------------------------------------

export type ComparisonKind = 'working' | 'pr';
// a resolved Comparison: its base label, the diffable base ref, the working-tree status, and its Changes
export type Comparison = { kind: ComparisonKind; base: string; gitBase: string; status: GitStatusSummary; changes: GitStatusChange[] };
export type ComparisonFailure = 'unavailable' | 'conflicted' | 'no_base';
export type ComparisonResult = { ok: true; comparison: Comparison } | { ok: false; reason: ComparisonFailure };

// resolve a Comparison's Changes. Working folds HEAD vs the working tree (staged and unstaged
// together, untracked included); All PR compares the merge base of HEAD and the first resolvable
// candidate. A conflicted working tree is refused before any base is chosen. `lineStats` enriches
// the Working Changes' additions/deletions (All PR always carries them) — set it when the caller
// fingerprints the Comparison, so an edit inside a capped file still moves the fingerprint.
export async function resolveComparison(workspace: string, kind: ComparisonKind, candidates: string[] = [], options: { lineStats?: boolean } = {}): Promise<ComparisonResult> {
  const status = await workingStatus(workspace, { lineStats: kind === 'working' && options.lineStats });
  if (status === undefined) return { ok: false, reason: 'unavailable' };
  if (status.conflicted > 0) return { ok: false, reason: 'conflicted' };
  if (kind === 'working') {
    const head = await resolveHead(workspace);
    return { ok: true, comparison: { kind, base: head.base, gitBase: head.gitBase, status, changes: status.changes ?? [] } };
  }
  const untracked = status.changes?.filter(change => change.code === '??') ?? [];
  const resolved = await comparisonAgainst(workspace, candidates, untracked);
  if (resolved === undefined) return { ok: false, reason: 'no_base' };
  return { ok: true, comparison: { kind, base: resolved.comparison.base, gitBase: resolved.gitBase, status, changes: resolved.comparison.changes ?? [] } };
}

// ---- Per-file patch capture -----------------------------------------------------------------

export type UntrackedPatchKind = 'metadata' | 'binary' | 'untracked';
export type UntrackedPatch = { patch: string; kind: UntrackedPatchKind } | { tooLarge: true };

// synthesise a bounded patch for one untracked path without following symlinks; returns
// `tooLarge` when the file exceeds `maxBytes`, and a metadata note for anything not a plain file
export async function synthesizeUntrackedPatch(workspace: string, change: GitStatusChange, maxBytes: number): Promise<UntrackedPatch> {
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
    if (openedInfo.size > maxBytes) return { tooLarge: true };
    const bounded = Buffer.alloc(maxBytes + 1);
    const read = await handle.read(bounded, 0, bounded.length, 0);
    // reject files that grew beyond the validated limit
    if (read.bytesRead > maxBytes) return { tooLarge: true };
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

// capture the unified patch for one tracked Change against `base`; `ok: false` means git failed
export async function capturePatch(workspace: string, base: string, change: GitStatusChange): Promise<{ ok: true; patch: string } | { ok: false }> {
  const paths = [change.originalPath, change.path].filter((path): path is string => path !== undefined);
  // Force the standard a/ b/ path prefixes so the patch parses regardless of the user's git config:
  // diff.mnemonicPrefix (c/ w/ i/ …), diff.noprefix, and custom diff.srcPrefix/dstPrefix would
  // otherwise flow into the header, and @pierre/diffs' parser rejects a non-a/b header ("invalid git
  // diff header") — leaving the diff nameless, which breaks file-at-revision loads (full context,
  // Load anyway) and the Review tour. Explicit --src-prefix/--dst-prefix override every prefix config.
  const result = await run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--find-renames', base, '--', ...paths], undefined, 20_000);
  // surface git failures to the caller
  if (result.code !== 0) return { ok: false };
  return { ok: true, patch: result.stdout || `${change.code.trim() || 'metadata'} ${change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}` };
}

// ---- Comparison patch (all files) + fingerprint --------------------------------------------

export type ComparisonFileKind = 'tracked' | UntrackedPatchKind;
export type ComparisonFile = { change: GitStatusChange; kind: ComparisonFileKind; patch: string; capped: boolean };
export type ComparisonPatch = { base: string; gitBase: string; files: ComparisonFile[]; fingerprint: string; truncated: boolean };
export type PatchLimits = { perFileBytes: number; totalBytes: number; maxFiles: number };

// capture per-file patches for every Change in a Comparison, honouring per-file, total, and
// file-count caps (a file past the per-file or running-total cap is marked `capped` with its patch
// withheld for lazy loading; reaching the file-count cap stops capture and marks the result
// truncated), and derive a deterministic, content-sensitive fingerprint over the base, the
// captured patches, and each Change's line counts
export async function captureComparisonPatch(workspace: string, comparison: Comparison, limits: PatchLimits): Promise<ComparisonPatch> {
  const files: ComparisonFile[] = [];
  let total = 0;
  let truncated = false;
  for (const change of comparison.changes) {
    // bound the number of captured Changes, not only their bytes
    if (files.length >= limits.maxFiles) { truncated = true; break; }
    let kind: ComparisonFileKind;
    let patch: string;
    if (change.code === '??') {
      const synth = await synthesizeUntrackedPatch(workspace, change, limits.perFileBytes);
      // a file past the per-file cap is withheld without reading it whole
      if ('tooLarge' in synth) { files.push({ change, kind: 'untracked', patch: '', capped: true }); continue; }
      kind = synth.kind;
      patch = synth.patch;
    } else {
      const captured = await capturePatch(workspace, comparison.gitBase, change);
      // an unavailable per-file diff is surfaced as an empty entry rather than failing the whole Comparison
      kind = 'tracked';
      patch = captured.ok ? captured.patch : '';
    }
    const bytes = Buffer.byteLength(patch);
    // withhold a patch that breaches either the per-file or the running-total cap
    if (bytes > limits.perFileBytes || total + bytes > limits.totalBytes) {
      if (total + bytes > limits.totalBytes) truncated = true;
      files.push({ change, kind, patch: '', capped: true });
      continue;
    }
    total += bytes;
    files.push({ change, kind, patch, capped: false });
  }
  // fold each Change's line counts in so an edit confined to a capped file still moves the fingerprint
  const fingerprint = digest(JSON.stringify([comparison.base, comparison.gitBase, files.map(file => [file.change.code, file.change.path, file.change.originalPath ?? null, file.change.additions ?? null, file.change.deletions ?? null, file.capped, file.patch])]));
  return { base: comparison.base, gitBase: comparison.gitBase, files, fingerprint, truncated };
}

// ---- File at a revision ---------------------------------------------------------------------

const maxRevisionBytes = 256 * 1024;
export type RevisionFile = { path: string; size: number; binary: boolean; truncated: boolean; content?: string };
// which side of a Comparison to read a file from: a committed revision, or the live working tree
export type FileRevision = { commit: string } | { workingTree: true };

// read git's `show` output for one blob, collecting at most `maxBytes` before stopping; resolves
// undefined when the object is absent (git exits non-zero having produced nothing)
function gitShowBounded(workspace: string, object: string, maxBytes: number): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const child = spawn(git, ['--no-optional-locks', '-C', workspace, 'show', object], { shell: false, env: safeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      // stop reading once the cap is reached; the close handler keeps what was collected
      if (total >= maxBytes) child.kill('SIGKILL');
    });
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      // a genuine miss exits non-zero with no output; a capped read exits non-zero with bytes in hand
      if (failed || (code !== 0 && chunks.length === 0)) resolve(undefined);
      else resolve(Buffer.concat(chunks));
    });
  });
}

// read a file's contents at a revision (git object store) or from the working tree (secure fs
// read via WorkspaceFileService), capped at 256 KB; undefined when the path is absent there
export async function fileAtRevision(workspace: string, revision: FileRevision, path: string): Promise<RevisionFile | undefined> {
  // a NUL in the path makes spawn throw; treat it as absent, matching the working-tree branch
  if (path.includes('\0')) return undefined;
  if ('workingTree' in revision) {
    const preview = await new WorkspaceFileService().preview(workspace, path);
    if (preview === undefined) return undefined;
    return { path: preview.path, size: preview.size, binary: preview.binary, truncated: preview.truncated, ...(preview.content === undefined ? {} : { content: preview.content }) };
  }
  // refuse a revision git would read as an option (e.g. `--output=…`, an arbitrary-file-write
  // primitive) or that would corrupt the `<rev>:<path>` object spec; a real ref/sha has none of these
  if (revision.commit === '' || revision.commit.startsWith('-') || /[\0:]/u.test(revision.commit)) return undefined;
  const object = `${revision.commit}:${path}`;
  const [type, size] = await Promise.all([
    run(git, ['-C', workspace, 'cat-file', '-t', object]),
    run(git, ['-C', workspace, 'cat-file', '-s', object])
  ]);
  // require a regular file: a missing path fails, and a directory resolves to a tree object we must not read as text
  if (type.code !== 0 || type.stdout.trim() !== 'blob' || size.code !== 0) return undefined;
  const total = Number(size.stdout.trim());
  if (!Number.isInteger(total) || total < 0) return undefined;
  const bytes = await gitShowBounded(workspace, object, maxRevisionBytes);
  if (bytes === undefined) return undefined;
  const content = bytes.subarray(0, Math.min(bytes.length, maxRevisionBytes));
  // one binary heuristic across both sides: match WorkspaceFileService.preview's whole-buffer NUL sniff
  const binary = content.includes(0);
  return { path, size: total, binary, truncated: total > content.length, ...(binary ? {} : { content: content.toString('utf8') }) };
}
