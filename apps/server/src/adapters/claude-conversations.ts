import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileHead, readFileTail } from './bounded-file.js';
import type { ConversationSummary } from './types.js';

/**
 * Claude Code Conversation lookup for the Adapter (ADR 0002). A Conversation id is
 * a session UUID; its name is read from the transcript on disk. The console never
 * walks `/proc` for Claude (its transcript fd is not held open) and has no
 * `discover` — a reported `@rac_session` id, or nothing.
 *
 * The config directory is resolved under an injectable root: the test seam
 * `RAC_CLAUDE_CONFIG_DIR` wins, then Claude's own `CLAUDE_CONFIG_DIR`, then
 * `~/.claude`.
 */

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// bound the transcript read: the human `custom-title`, the generated `ai-title`
// and the first typed prompt all sit near the head, so a bounded head scan finds
// a name without loading a long conversation into memory (mirrors Codex's bounded
// rollout reads).
const maxTitleScanBytes = 4 * 1024 * 1024;
// the sidecar holds one small `{ "customTitle": "…" }` object; bound its read like
// every other read in this file rather than slurping an arbitrary path
const maxSidecarBytes = 64 * 1024;
const maxTitleLength = 120;
// listing bounds: open only the newest transcripts per directory, and scan a bounded
// head (the entrypoint marker and any leading `custom-title` sit near it) plus a bounded
// tail (Claude re-emits `custom-title`/`ai-title` at every prompt boundary and the last
// timestamped record lives at the end).
const maxListedTranscripts = 200;
const maxListHeadBytes = 128 * 1024;
const maxListTailBytes = 256 * 1024;
// a `-p`/SDK run is persisted but hidden from Claude's own picker and `--continue`; its
// message records carry one of these entrypoints (read from the head or the tail).
const sdkEntrypoints = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
// a top-level transcript filename is exactly `<session-uuid>.jsonl`
const transcriptFile = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export function validClaudeSessionId(id: string): boolean {
  return sessionId.test(id);
}

// whitespace-normalize and clamp a title, so unbounded operator text never reaches
// a Bookmark or the UI (mirrors Codex's `messageTitle`).
function compactTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

// Claude's config directory, honoring the test seam then the real environment.
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAC_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
}

// Claude's 31-multiplier int32 string hash over the original path, base36, ported from
// the binary's `wK`/`Te` encoder for the long-directory case below.
function projectHash(cwd: string): string {
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

// Claude stores a transcript under `projects/<cwd-with-non-alphanumerics-dashed>/`
// (docs/sessions). A dashed name over 200 characters is truncated to 200 and a hash of
// the original path appended, matching the binary's `gA` encoder.
function encodeProject(cwd: string): string {
  const dashed = cwd.replace(/[^a-zA-Z0-9]/gu, '-');
  return dashed.length <= 200 ? dashed : `${dashed.slice(0, 200)}-${projectHash(cwd)}`;
}

type TranscriptRecord = {
  type?: string;
  customTitle?: unknown;
  aiTitle?: unknown;
  promptSource?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
};

// the per-session `custom-title.json` sidecar's human name, when present. Claude
// writes it next to the transcript (`projects/<enc>/<id>/custom-title.json`) on a
// `/rename` or `--name`, but a `-p --name` run writes only the transcript record,
// so an absent sidecar is "unnamed", not an error.
async function sidecarCustomTitle(transcriptPath: string, id: string): Promise<string | undefined> {
  const lines = await readFileHead(join(dirname(transcriptPath), id, 'custom-title.json'), maxSidecarBytes).catch(() => undefined);
  if (lines === undefined) return undefined;
  try {
    const parsed = JSON.parse(lines.join('\n')) as { customTitle?: unknown };
    return typeof parsed.customTitle === 'string' && parsed.customTitle.length > 0 ? parsed.customTitle : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The current name of a known Claude Conversation: the human `custom-title` (the
 * transcript's last such record, or the per-session sidecar, which are equal
 * sources), else the last generated `ai-title`, else the first typed human prompt.
 * The human title wins over any `ai-title` regardless of record order — Claude
 * re-emits an `ai-title` after every prompt boundary, so a renamed session's
 * transcript ends on a generated title the console must not show (the read-back
 * and bookmark bug). `undefined` on any error — an unknown id, an unknown cwd, or
 * an unreadable/absent transcript. `cwd` locates the transcript and is required.
 */
export async function claudeConversationName(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validClaudeSessionId(id) || cwd === undefined) return undefined;
  const path = join(claudeConfigDir(env), 'projects', encodeProject(cwd), `${id}.jsonl`);
  const lines = await readFileHead(path, maxTitleScanBytes).catch(() => undefined);
  if (lines === undefined) return undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  for (const line of lines) {
    if (line === '') continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line) as TranscriptRecord; } catch { continue; }
    // several records of each kind per file; the last in the scanned window wins (a rename re-emits its title)
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.length > 0) customTitle = record.customTitle;
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) aiTitle = record.aiTitle;
    // the fallback is the first typed human prompt whose content is a plain string
    else if (firstPrompt === undefined && record.type === 'user' && record.promptSource === 'typed' && record.origin?.kind === 'human' && typeof record.message?.content === 'string' && record.message.content.length > 0) firstPrompt = record.message.content;
  }
  // the sidecar is an equal source for the human name, and survives a bounded head
  // scan that missed a re-emitted `custom-title` deep in a long transcript
  return compactTitle((customTitle ?? await sidecarCustomTitle(path, id)) ?? aiTitle ?? firstPrompt ?? '');
}

// what one transcript's bounded head+tail scan yields for listing
type TranscriptScan = { customTitle?: string; aiTitle?: string; lastActiveAt: number; sdk: boolean };

// accumulate a transcript's name, recency and provenance from raw JSONL lines. Called on
// the head then the tail, so the last `custom-title`/`ai-title` seen (nearest the tail)
// wins, exactly as `claudeConversationName` prefers the last record in its window.
function scanTranscript(lines: Iterable<string>, scan: TranscriptScan): void {
  for (const line of lines) {
    if (line === '') continue;
    let record: TranscriptRecord & { entrypoint?: unknown; timestamp?: unknown };
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.length > 0) scan.customTitle = record.customTitle;
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) scan.aiTitle = record.aiTitle;
    // `--print`/SDK runs are hidden from the picker; their marker sits on message records
    if (typeof record.entrypoint === 'string' && sdkEntrypoints.has(record.entrypoint)) scan.sdk = true;
    // last-active is the newest timestamped record, never the file mtime (bookkeeping
    // records without timestamps are appended at open/close and would move mtime)
    if (typeof record.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (!Number.isNaN(at) && at > scan.lastActiveAt) scan.lastActiveAt = at;
    }
  }
}

// summarize one transcript, or undefined when it is an SDK run or carries no name
async function summarizeTranscript(path: string, size: number, id: string, directory: string): Promise<ConversationSummary | undefined> {
  const scan: TranscriptScan = { lastActiveAt: 0, sdk: false };
  const head = await readFileHead(path, maxListHeadBytes).catch(() => undefined);
  if (head === undefined) return undefined;
  scanTranscript(head, scan);
  // read the tail too only when the file exceeds the head window; a smaller file was read whole
  if (size > maxListHeadBytes) scanTranscript(await readFileTail(path, maxListTailBytes).catch(() => []), scan);
  if (scan.sdk) return undefined;
  // the sidecar is an equal source for the human name (as in `claudeConversationName`):
  // it recovers a `custom-title` set long ago that fell outside the bounded window with no
  // re-emit, so a human-named row is neither mislabelled automatic nor dropped. Consulted
  // only when the window found no `custom-title`; a genuinely automatic row has no sidecar
  // directory, so the read fails fast.
  const customTitle = scan.customTitle ?? await sidecarCustomTitle(path, id);
  const name = compactTitle((customTitle ?? scan.aiTitle) ?? '');
  // list only Named conversations — a transcript with neither title is unnamed
  if (name === undefined) return undefined;
  return { id, name, automatic: customTitle === undefined, lastActiveAt: scan.lastActiveAt, directory };
}

/**
 * The Named Claude conversations started under each of the given directories, newest
 * (most recently active) first across all of them. For each directory the reader lists
 * the top-level `<uuid>.jsonl` transcripts under `projects/<encoded cwd>/`, skips 0-byte
 * files, opens only the newest 200 by mtime (mtime only ever runs ahead of activity, so
 * it is a safe pre-filter), and skips SDK/`--print` runs and any transcript with no name.
 * A missing or unreadable project directory contributes nothing. `directory` on each row
 * is the scanned cwd, matched exactly as Claude's own picker does.
 */
export async function claudeConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  const configDir = claudeConfigDir(env);
  const summaries: ConversationSummary[] = [];
  for (const directory of directories) {
    const projectDir = join(configDir, 'projects', encodeProject(directory));
    const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ id: string; path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = transcriptFile.exec(entry.name);
      if (match === null) continue;
      const path = join(projectDir, entry.name);
      const info = await stat(path).catch(() => undefined);
      // skip an unreadable or empty transcript (a 0-byte file has no message record)
      if (info === undefined || info.size === 0) continue;
      candidates.push({ id: match[1].toLowerCase(), path, size: info.size, mtimeMs: info.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates.slice(0, maxListedTranscripts)) {
      const summary = await summarizeTranscript(candidate.path, candidate.size, candidate.id, directory).catch(() => undefined);
      if (summary !== undefined) summaries.push(summary);
    }
  }
  summaries.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  return summaries;
}
