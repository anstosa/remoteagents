import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

// the bounded head of a file as raw lines, dropping a trailing partial record
async function readHead(path: string, maxBytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // a file longer than the scan window ends mid-record; drop the partial tail line
    if (size > length) lines.pop();
    return lines;
  } finally {
    await handle.close();
  }
}

// Claude's config directory, honoring the test seam then the real environment.
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAC_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
}

// Claude stores a transcript under `projects/<cwd-with-non-alphanumerics-dashed>/`
// (docs/sessions). The long-path truncation+hash case degrades to "not found".
function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
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
  const lines = await readHead(join(dirname(transcriptPath), id, 'custom-title.json'), maxSidecarBytes).catch(() => undefined);
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
  const lines = await readHead(path, maxTitleScanBytes).catch(() => undefined);
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
