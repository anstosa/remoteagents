import { open, readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from './types.js';

/**
 * Codex conversation lookup, gathered behind the Adapter (ADR 0002). These are
 * the only filesystem-touching functions the Codex Adapter owns: the `/proc`
 * fd-walk that finds the rollout files a pane holds open, the bounded
 * `session_meta` read that picks the single top-level Conversation, and the
 * title scan. Roots are injectable through the same environment variables the
 * console has always used (`RAC_HOST_PROC`, `CODEX_HOME`), so behaviour is
 * unchanged from when this lived in `discovery/processes.ts` and
 * `bookmarks/service.ts`. ("Rollout" is Codex's own name for these `.jsonl`
 * files; "Session" is reserved for tmux, per CONTEXT.md.)
 */

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// validate one exact Codex thread UUID
export const validCodexThreadId = (value: string): boolean => threadIdPattern.test(value);

const maxMetadataBytes = 128 * 1024;
const maxTitleLength = 120;
const maxTitleScanBytes = 4 * 1024 * 1024;
const maxRolloutEntries = 4_096;

type RolloutRef = { id: string; relativePath: string };
type RolloutMetadata = { id: string; cwd: string; parentThreadId?: string };

function procRoot(): string {
  return process.env.RAC_HOST_PROC ?? '/proc';
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex');
}

// validate one session-relative rollout path before it reaches the filesystem
function validRolloutRef(value: RolloutRef): boolean {
  const parts = value.relativePath.split('/');
  return validCodexThreadId(value.id)
    && value.relativePath.length <= 4_096
    && parts[0] === 'sessions'
    && parts.length >= 3
    && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
    && value.relativePath.endsWith(`-${value.id}.jsonl`);
}

// collect exact rollout identities held open by one pane process tree
export async function openRollouts(root: number): Promise<RolloutRef[]> {
  const proc = procRoot();
  const pending = [root];
  const seen = new Set<number>();
  const rollouts = new Map<string, RolloutRef>();
  let inspectedDescriptors = 0;
  // bound process and descriptor traversal
  while (pending.length > 0 && seen.size < 256 && inspectedDescriptors < maxRolloutEntries) {
    const pid = pending.pop()!;
    // inspect each live process once
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = (await readFile(`${proc}/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean).map(Number);
      // retain live descendants
      for (const child of children) if (Number.isInteger(child) && child > 0) pending.push(child);
      const descriptors = await readdir(`${proc}/${pid}/fd`);
      // read bounded open-file targets
      for (const descriptor of descriptors) {
        if (inspectedDescriptors >= maxRolloutEntries) break;
        inspectedDescriptors += 1;
        const target = await readlink(`${proc}/${pid}/fd/${descriptor}`).catch(() => '');
        const match = /(?:^|\/)(sessions\/[^\0]{1,3800}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl)$/iu.exec(target);
        // retain exact Codex rollout filenames only
        if (match?.[1] !== undefined && match[2] !== undefined && !match[1].split('/').includes('..')) rollouts.set(`${match[2]}:${match[1]}`, { id: match[2], relativePath: match[1] });
      }
    } catch {
      // ignore exited or unreadable processes
    }
  }
  return [...rollouts.values()];
}

// read bounded metadata from one Codex rollout
async function rolloutMetadata(file: string): Promise<RolloutMetadata | undefined> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxMetadataBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    // reject missing records
    if (!firstLine) return undefined;
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: unknown };
    // require session metadata
    if (record.type !== 'session_meta' || record.payload === null || typeof record.payload !== 'object') return undefined;
    const payload = record.payload as { id?: unknown; cwd?: unknown; originator?: unknown; parent_thread_id?: unknown };
    // accept only top-level interactive Codex conversations
    if (typeof payload.id !== 'string' || !validCodexThreadId(payload.id) || typeof payload.cwd !== 'string' || payload.originator !== 'codex-tui') return undefined;
    return { id: payload.id, cwd: payload.cwd, ...(typeof payload.parent_thread_id === 'string' ? { parentThreadId: payload.parent_thread_id } : {}) };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// normalize a user message into a compact title
function messageTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  // ignore injected session context
  if (!normalized || normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')) return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

// extract message text from one Codex response item
function userMessage(payload: unknown): string | undefined {
  // require one user message payload
  if (payload === null || typeof payload !== 'object') return undefined;
  const message = payload as { type?: unknown; role?: unknown; content?: unknown };
  // reject non-user records
  if (message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((item): item is { text: string } => item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string')
    .map(item => item.text)
    .join('\n');
  return messageTitle(text);
}

// find the latest useful user message in one rollout
async function rolloutTitle(file: string): Promise<string | undefined> {
  let title: string | undefined;
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxTitleScanBytes);
    const offset = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // discard a partial leading record
    if (offset > 0) lines.shift();
    // scan the bounded tail in order
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
        // retain the newest visible user request
        if (record.type === 'response_item') title = userMessage(record.payload) ?? title;
      } catch {
        // preserve earlier valid records
      }
    }
  } finally {
    await handle.close();
  }
  return title;
}

// locate the pane's one top-level rollout, failing closed on ambiguity
async function selectTopLevelRollout(refs: RolloutRef[]): Promise<{ id: string; file: string } | undefined> {
  const home = codexHome();
  const matches: Array<{ id: string; file: string }> = [];
  // inspect only rollouts held open by the selected pane
  for (const ref of refs) {
    // reject malformed rollout paths before opening them
    if (!validRolloutRef(ref)) continue;
    const file = join(home, ref.relativePath);
    const metadata = await rolloutMetadata(file).catch(() => undefined);
    // retain top-level conversations only
    if (metadata !== undefined && metadata.parentThreadId === undefined && metadata.id === ref.id) matches.push({ id: metadata.id, file });
  }
  // fail closed on missing or ambiguous pane identity
  if (matches.length !== 1) return undefined;
  return matches[0];
}

/**
 * The pane's current top-level Codex conversation, resolved by the fd-walk plus
 * the `session_meta` read, failing closed when the pane holds no single
 * unambiguous top-level rollout. Reproduces the old
 * `discovery.sessions` + `CodexBookmarkService.selectedSession` pair (now the
 * `BookmarkService` holds only persistence).
 */
export async function discoverCodexConversation(pid: number): Promise<Conversation | undefined> {
  const selected = await selectTopLevelRollout(await openRollouts(pid));
  // require one exact pane-to-conversation mapping
  if (selected === undefined) return undefined;
  const title = await rolloutTitle(selected.file).catch(() => undefined);
  return { id: selected.id, ...(title === undefined ? {} : { title }) };
}

// walk the bounded sessions tree for the rollout carrying one exact thread id,
// visiting recent date-partitions first (`sessions/YYYY/MM/DD`) so a live
// conversation is found before the entry cap on a host with deep history
async function rolloutFileById(id: string): Promise<string | undefined> {
  const home = codexHome();
  const suffix = `-${id}.jsonl`;
  const pending = [join(home, 'sessions')];
  let inspected = 0;
  while (pending.length > 0 && inspected < maxRolloutEntries) {
    const directory = pending.pop()!;
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((left, right) => left.name.localeCompare(right.name));
    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (inspected >= maxRolloutEntries) break;
      inspected += 1;
      // match exact rollout filenames, defer directories so the newest is popped first
      if (entry.isDirectory()) subdirectories.push(join(directory, entry.name));
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) return join(directory, entry.name);
    }
    // ascending push + LIFO pop visits the highest-numbered (most recent) partition first
    pending.push(...subdirectories);
  }
  return undefined;
}

/**
 * The title of one already-known Codex conversation, used when the pane reports
 * its thread through `@rac_session` so the console can skip the fd-walk. A thread
 * id is globally unique, so the rollout is located by id alone — reproducing the
 * old fd-walk title without gating on a path comparison the workspace realpath
 * would fail.
 */
export async function codexConversationTitle(id: string): Promise<string | undefined> {
  // reject material that could escape the sessions tree
  if (!validCodexThreadId(id)) return undefined;
  const file = await rolloutFileById(id);
  if (file === undefined) return undefined;
  const metadata = await rolloutMetadata(file).catch(() => undefined);
  // confirm the located rollout is the Codex conversation it claims by id
  if (metadata === undefined || metadata.id !== id) return undefined;
  return await rolloutTitle(file).catch(() => undefined);
}
