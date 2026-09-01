import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code Conversation lookup for the Adapter (ADR 0002). A Conversation id is
 * a session UUID; its title is read from the transcript on disk. The console never
 * walks `/proc` for Claude (its transcript fd is not held open) and has no
 * `discover` — a reported `@rac_session` id, or nothing.
 *
 * The config directory is resolved under an injectable root: the test seam
 * `RAC_CLAUDE_CONFIG_DIR` wins, then Claude's own `CLAUDE_CONFIG_DIR`, then
 * `~/.claude`.
 */

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// bound the transcript read: the `ai-title` and the first typed prompt both sit
// near the head, so a bounded head scan finds a title without loading a long
// conversation into memory (mirrors Codex's bounded rollout reads).
const maxTitleScanBytes = 4 * 1024 * 1024;
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
  aiTitle?: unknown;
  promptSource?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
};

/**
 * The human title of a known Claude Conversation: the transcript's last `ai-title`
 * record, else the first typed human prompt. `undefined` on any error — an unknown
 * id, an unknown cwd, or an unreadable/absent transcript — so the caller falls back
 * to a generic label. `cwd` locates the transcript and is required.
 */
export async function claudeConversationTitle(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validClaudeSessionId(id) || cwd === undefined) return undefined;
  const path = join(claudeConfigDir(env), 'projects', encodeProject(cwd), `${id}.jsonl`);
  const lines = await readHead(path, maxTitleScanBytes).catch(() => undefined);
  if (lines === undefined) return undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  for (const line of lines) {
    if (line === '') continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line) as TranscriptRecord; } catch { continue; }
    // several ai-title records per file; the last one in the scanned window wins (a rename or plan title replaces it)
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) aiTitle = record.aiTitle;
    // the fallback is the first typed human prompt whose content is a plain string
    else if (firstPrompt === undefined && record.type === 'user' && record.promptSource === 'typed' && record.origin?.kind === 'human' && typeof record.message?.content === 'string' && record.message.content.length > 0) firstPrompt = record.message.content;
  }
  return compactTitle(aiTitle ?? firstPrompt ?? '');
}
