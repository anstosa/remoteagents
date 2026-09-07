import { open, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileTail } from './bounded-file.js';
import type { CompletionBaseline, CompletionEvent, Conversation, ConversationSummary } from './types.js';

/**
 * Codex conversation lookup, gathered behind the Adapter (ADR 0002). These are
 * the only filesystem-touching functions the Codex Adapter owns: the `/proc`
 * fd-walk that finds the rollout files a pane holds open, the bounded
 * `session_meta` read that picks the single top-level Conversation, the
 * discover-time title scan, and the Conversation-name read from the
 * `session_index.jsonl` sidecar. Roots are injectable through the same
 * environment variables the console has always used (`RAC_HOST_PROC`,
 * `CODEX_HOME`), so behaviour is unchanged from when this lived in
 * `discovery/processes.ts`. ("Rollout" is Codex's own
 * name for these `.jsonl` files; "Session" is reserved for tmux, per CONTEXT.md.)
 */

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// validate one exact Codex thread UUID
export const validCodexThreadId = (value: string): boolean => threadIdPattern.test(value);

const maxMetadataBytes = 128 * 1024;
const maxTitleLength = 120;
const maxTitleScanBytes = 4 * 1024 * 1024;
const maxCompletionScanBytes = 4 * 1024 * 1024;
// bound the account-global session-index read to its recent tail. The sidecar is
// append-only and last-write-wins, so the current name is at the file's end; a
// smaller-than-cap file is read whole (a true forward read). `readName`'s callers
// (the console read-back, the discover-time name) target a recently active thread, whose
// line is near the tail. Above the cap the oldest threads' names fail *safe* — an
// unread line yields `undefined` (a generic label), never a wrong name. A future
// `list` that enumerates long-idle threads must not lean on this by-id read.
const maxIndexScanBytes = 8 * 1024 * 1024;
const maxAnswerLength = 64_000;
const maxRolloutEntries = 4_096;
// rollout files inspected when matching by working directory: the live session is
// effectively always among the newest, so a smaller bound keeps the per-turn scan
// cheap on a host with deep history
const maxCwdRolloutScans = 512;
// bound the per-rollout tail read that finds a listed row's `lastActiveAt`: the newest
// record's timestamp sits at the very end, so a small tail suffices (mirrors Claude's list)
const maxListTailBytes = 256 * 1024;

type RolloutRef = { id: string; relativePath: string };
type RolloutMetadata = { id: string; cwd: string; parentThreadId?: string; createdAt?: number };

function procRoot(): string {
  return process.env.RAC_HOST_PROC ?? '/proc';
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
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
      const children = (await readFile(`${proc}/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/u).filter(Boolean).map(Number);
      // retain live descendants
      for (const child of children) if (Number.isInteger(child) && child > 0) pending.push(child);
      // read bounded open-file targets (a confined service cannot readlink a
      // sandboxed pane's descriptors: the readlink then fails and the pane's
      // rollout is instead matched by its working directory, below)
      const descriptors = await readdir(`${proc}/${pid}/fd`).catch(() => []);
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
    const payload = record.payload as { id?: unknown; cwd?: unknown; originator?: unknown; parent_thread_id?: unknown; timestamp?: unknown };
    // accept only top-level interactive Codex conversations
    if (typeof payload.id !== 'string' || !validCodexThreadId(payload.id) || typeof payload.cwd !== 'string' || payload.originator !== 'codex-tui') return undefined;
    // the recorded session start, epoch ms; used to tell a post-reset rollout from the pre-reset one
    const createdAt = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
    return { id: payload.id, cwd: payload.cwd, ...(typeof payload.parent_thread_id === 'string' ? { parentThreadId: payload.parent_thread_id } : {}), ...(Number.isFinite(createdAt) ? { createdAt } : {}) };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// normalize a user message into a compact title, ignoring injected session context
function messageTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')) return undefined;
  return compactName(normalized);
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

// find the latest useful user message in one rollout's bounded tail
async function rolloutTitle(file: string): Promise<string | undefined> {
  let title: string | undefined;
  for (const line of await readFileTail(file, maxTitleScanBytes)) {
    try {
      const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
      // retain the newest visible user request
      if (record.type === 'response_item') title = userMessage(record.payload) ?? title;
    } catch {
      // preserve earlier valid records
    }
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
 * unambiguous top-level rollout. The working-directory match (`cwd`, supplied
 * only when unique among live panes) is the same privilege-free fallback
 * `codexRolloutBaseline` uses when a confined service cannot readlink the
 * pane's descriptors and the fd-walk finds nothing. Reproduces the old
 * `discovery.sessions` + `selectedSession` pair that resolved a pane to its
 * exact rollout.
 */
export async function discoverCodexConversation(pane: { pid: number; cwd?: string }): Promise<Conversation | undefined> {
  const selected = await paneRollout(pane);
  // require one exact pane-to-conversation mapping
  if (selected === undefined) return undefined;
  const title = await rolloutTitle(selected.file).catch(() => undefined);
  return { id: selected.id, ...(title === undefined ? {} : { title }) };
}

/**
 * The pane's live top-level rollout located by its working directory, for the
 * confined service that cannot readlink a sandboxed pane's descriptors (the
 * fd-walk then finds nothing). Walks the bounded sessions tree newest-first and
 * returns the first top-level Codex rollout whose recorded `cwd` matches, so the
 * live conversation is found before older history in the same directory. The
 * caller supplies `cwd` only when it is unique among live panes, so a directory
 * running two agents never resolves to a sibling's rollout.
 *
 * When `createdAfter` is given (a `/new` reset instant), a matching rollout must
 * also have been recorded after it, so the pane's still-open pre-reset rollout is
 * skipped and only the freshly opened post-reset thread resolves.
 */
async function rolloutByCwd(cwd: string, createdAfter?: number): Promise<{ id: string; file: string } | undefined> {
  // Codex records a host-canonical `cwd` and the pane path is host-canonical too
  // (tmux reads it from the pane's `/proc/<pid>/cwd`), so match the raw string first.
  // That holds under Docker, where a host worktree can be bind-mounted at a different
  // container path and an in-container `realpath` would resolve it somewhere else; the
  // canonical form is only a fallback for a genuinely symlinked local pane path.
  const canonical = await realpath(cwd).catch(() => cwd);
  for await (const { file, metadata } of walkRollouts(codexHome())) {
    // match the pane's live top-level conversation in this directory, skipping any
    // rollout that predates a supplied reset instant (the pre-reset thread)
    if (metadata !== undefined && metadata.parentThreadId === undefined && (metadata.cwd === cwd || metadata.cwd === canonical)
      && (createdAfter === undefined || (metadata.createdAt !== undefined && metadata.createdAt > createdAfter))) return { id: metadata.id, file };
  }
  return undefined;
}

// Walk a Codex home's sessions tree newest-first — newest rollout within a date partition,
// newest partition across them — yielding each rollout's path and bounded `session_meta` up to
// the `maxCwdRolloutScans` cap. The live-pane working-directory match and the Named-conversation
// listing share this one bounded walk (an early `break` in the caller stops the generator, so a
// match found among the newest files never reads the rest of a deep-history home).
async function* walkRollouts(home: string): AsyncGenerator<{ file: string; metadata: RolloutMetadata | undefined }> {
  const pending = [join(home, 'sessions')];
  let inspected = 0;
  while (pending.length > 0 && inspected < maxCwdRolloutScans) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    // newest rollout first within a partition, newest date-partition first across them
    const files = entries.filter(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort((left, right) => right.localeCompare(left));
    const subdirectories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort((left, right) => left.localeCompare(right)).map(name => join(directory, name));
    for (const name of files) {
      if (inspected >= maxCwdRolloutScans) break;
      inspected += 1;
      const file = join(directory, name);
      yield { file, metadata: await rolloutMetadata(file).catch(() => undefined) };
    }
    // ascending push + LIFO pop visits the highest-numbered (most recent) partition first
    pending.push(...subdirectories);
  }
}

// the pane's single top-level rollout: the exact fd-walk, else the privilege-free
// working-directory match when a confined service cannot readlink the descriptors
async function paneRollout(pane: { pid: number; cwd?: string }): Promise<{ id: string; file: string } | undefined> {
  return await selectTopLevelRollout(await openRollouts(pane.pid))
    ?? (pane.cwd === undefined ? undefined : await rolloutByCwd(pane.cwd));
}

// normalize whitespace and clamp a Codex display string to the shared bound, so
// neither a stored thread name nor a user message reaches the UI unbounded
function compactName(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

/**
 * The current Conversation name of an already-known Codex/OMX thread, read from
 * the account-global `session_index.jsonl` sidecar (`<CODEX_HOME>/session_index.jsonl`).
 * The sidecar is append-only — one `{ id, thread_name, updated_at }` line per name
 * change — so the last line carrying this id wins. Both codex and omx share
 * `~/.codex`, so this reads the same store for either kind. `undefined` when the
 * sidecar is absent (a fresh thread with no name yet) or carries no line for the id.
 */
export async function codexConversationName(id: string): Promise<string | undefined> {
  // reject material before it reaches a comparison
  if (!validCodexThreadId(id)) return undefined;
  const lines = await readFileTail(join(codexHome(), 'session_index.jsonl'), maxIndexScanBytes).catch(() => undefined);
  if (lines === undefined) return undefined;
  let name: string | undefined;
  // append-only, last write wins: keep the newest name recorded for this id
  for (const record of sidecarNameLines(lines)) if (record.id === id) name = record.name;
  return name === undefined ? undefined : compactName(name);
}

// every valid, non-empty `{ id, thread_name }` entry of the session-index sidecar, in file
// order — the shared parse the by-id read (`codexConversationName`) and the enumerate-all read
// (`codexConversationNames`) both fold in their own way.
function* sidecarNameLines(lines: Iterable<string>): Generator<{ id: string; name: string }> {
  for (const line of lines) {
    let record: { id?: unknown; thread_name?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (typeof record.id === 'string' && validCodexThreadId(record.id) && typeof record.thread_name === 'string' && record.thread_name.length > 0) yield { id: record.id, name: record.thread_name };
  }
}

/**
 * The current name of every Codex/OMX thread, read once from the account-global
 * `session_index.jsonl` sidecar. Unlike `codexConversationName`'s by-id read — which scans
 * the tail for one recently active thread and fails *safe* for anything older — `list`
 * enumerates long-idle threads, so it makes one forward pass over the (bounded) sidecar and
 * maps every id at once, the last line for an id winning. An absent sidecar maps nothing; a
 * thread whose name predates the `maxIndexScanBytes` tail is likewise treated as unnamed
 * (fails safe to a generic label, never a wrong name).
 */
async function codexConversationNames(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const lines = await readFileTail(join(codexHome(env), 'session_index.jsonl'), maxIndexScanBytes).catch(() => undefined);
  const names = new Map<string, string>();
  if (lines === undefined) return names;
  // append-only, last write wins: a later line for the id supersedes its earlier name
  for (const record of sidecarNameLines(lines)) {
    const name = compactName(record.name);
    if (name !== undefined) names.set(record.id, name);
  }
  return names;
}

// the newest record timestamp in a rollout's bounded tail (epoch ms), never the file mtime —
// Codex appends open/close bookkeeping that would move mtime past the last real activity.
// Every rollout record carries a top-level ISO `timestamp`; 0 when none is readable.
async function rolloutLastActiveAt(file: string): Promise<number> {
  let latest = 0;
  for (const line of await readFileTail(file, maxListTailBytes).catch(() => [])) {
    let record: { timestamp?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (typeof record.timestamp !== 'string') continue;
    const at = Date.parse(record.timestamp);
    if (!Number.isNaN(at) && at > latest) latest = at;
  }
  return latest;
}

/**
 * The Named Codex/OMX conversations started under each of the given directories, newest
 * (most recently active) first. One walk of the sessions tree — the same newest-first order
 * and 512-file cap `rolloutByCwd` uses — reads each rollout's `session_meta` first line for
 * id, cwd, originator and parentage, keeps only top-level (`parent_thread_id`-less)
 * `codex-tui` conversations whose recorded cwd matches one of the given directories raw or
 * canonical, and reads a bounded tail for `lastActiveAt`. The name is the sidecar's — a
 * rollout with no sidecar line is unnamed and omitted; `automatic` is never set for this kind,
 * which cannot tell a generated title from a typed one. Archived rollouts leave the sessions
 * tree, so they are absent. `directory` on each row is the given directory that matched (not
 * the possibly-canonical recorded cwd), so a listed row resolves back to its Worktree. On a
 * home deeper than the shared `maxCwdRolloutScans` cap the oldest Named rows are dropped, as
 * for the live-pane match.
 */
export async function codexConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  if (directories.length === 0) return [];
  // map a recorded cwd (raw or canonical) back to the given directory it should report as
  const directoryByPath = new Map<string, string>();
  for (const directory of directories) {
    if (!directoryByPath.has(directory)) directoryByPath.set(directory, directory);
    const canonical = await realpath(directory).catch(() => directory);
    if (!directoryByPath.has(canonical)) directoryByPath.set(canonical, directory);
  }
  const names = await codexConversationNames(env);
  const summaries: ConversationSummary[] = [];
  for await (const { file, metadata } of walkRollouts(codexHome(env))) {
    // keep only a top-level conversation started in one of the wanted directories
    if (metadata === undefined || metadata.parentThreadId !== undefined) continue;
    const startedIn = directoryByPath.get(metadata.cwd);
    if (startedIn === undefined) continue;
    // list only Named conversations — an unnamed rollout has no sidecar line
    const conversationName = names.get(metadata.id);
    if (conversationName === undefined) continue;
    summaries.push({ id: metadata.id, name: conversationName, lastActiveAt: await rolloutLastActiveAt(file), directory: startedIn });
  }
  summaries.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  return summaries;
}

/**
 * Codex records a turn's lifecycle in its rollout as ordinal-stamped events: a
 * `task_started`, the response items, then one terminal `task_complete` (carrying
 * the answer as `last_agent_message`) or `turn_aborted` on an interrupt. These
 * are the completion signal the native-Codex TUI never renders, so the console
 * reads them here instead of scraping the pane. Every record carries a monotonic
 * `ordinal`; the baseline snapshotted before a turn starts scopes the read to
 * that one turn.
 */

// the newest terminal turn among these rollout records past `sinceOrdinal`
export function completionFromRecords(lines: Iterable<string>, sinceOrdinal: number): CompletionEvent {
  let newest: { kind: 'completed'; ordinal: number; answer: string } | { kind: 'aborted'; ordinal: number } | undefined;
  for (const line of lines) {
    let record: { type?: unknown; ordinal?: unknown; payload?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    // consider only lifecycle events recorded after the baseline
    if (record.type !== 'event_msg' || typeof record.ordinal !== 'number' || record.ordinal <= sinceOrdinal) continue;
    // keep the newest terminal event; ignore non-terminal events at higher ordinals
    if (newest !== undefined && record.ordinal <= newest.ordinal) continue;
    if (record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as { type?: unknown; last_agent_message?: unknown };
    if (payload.type === 'task_complete') {
      const message = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      newest = { kind: 'completed', ordinal: record.ordinal, answer: message.length <= maxAnswerLength ? message : message.slice(0, maxAnswerLength) };
    } else if (payload.type === 'turn_aborted') {
      newest = { kind: 'aborted', ordinal: record.ordinal };
    }
  }
  return newest ?? { kind: 'pending' };
}

// the highest ordinal among these rollout records, or undefined when none parse
export function maxOrdinalFromRecords(lines: Iterable<string>): number | undefined {
  let max: number | undefined;
  for (const line of lines) {
    let ordinal: unknown;
    // skip unparseable or truncated lines
    try { ordinal = (JSON.parse(line) as { ordinal?: unknown }).ordinal; } catch { continue; }
    if (typeof ordinal === 'number' && (max === undefined || ordinal > max)) max = ordinal;
  }
  return max;
}

// the newest terminal turn recorded past the baseline's ordinal. A resolved
// baseline reads the exact file it pinned, so it never drifts to a sibling pane's
// rollout mid-turn; a deferred baseline resolves the post-reset thread first (the
// newest cwd-matching rollout created after the reset), staying `pending` until it
// appears.
export async function codexTurnSince(baseline: CompletionBaseline): Promise<CompletionEvent | undefined> {
  let rollout: string;
  // a resolved baseline names its pinned file; a deferred one resolves the post-reset rollout now
  if ('rollout' in baseline) rollout = baseline.rollout;
  else {
    const resolved = await rolloutByCwd(baseline.cwd, baseline.resetAt).catch(() => undefined);
    // Codex opens the new thread's rollout only at its first turn; keep polling
    if (resolved === undefined) return { kind: 'pending' };
    rollout = resolved.file;
  }
  const lines = await readFileTail(rollout, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? undefined : completionFromRecords(lines, baseline.ordinal);
}

// resolve the pane's rollout and snapshot its current max ordinal before a turn
// starts. The fd-walk (`pid`) is exact; the working-directory match (`cwd`) is the
// privilege-free fallback when a confined service cannot readlink the pane's
// descriptors. Returns undefined when no single rollout resolves or it cannot be read.
//
// `resetAt` marks a turn that first resets the conversation with `/new`: the pane
// still holds its pre-reset rollout open, so pinning it now would read the old
// thread. Return a deferred baseline (cwd + instant) instead and let `since`
// resolve the post-reset rollout once Codex opens it (the completion contract in
// `types.ts` covers why deferral needs the cwd).
export async function codexRolloutBaseline(pane: { pid: number; cwd?: string }, resetAt?: number): Promise<CompletionBaseline | undefined> {
  if (resetAt !== undefined) return pane.cwd === undefined ? undefined : { cwd: pane.cwd, resetAt, ordinal: 0 };
  const selected = await paneRollout(pane);
  if (selected === undefined) return undefined;
  const lines = await readFileTail(selected.file, maxCompletionScanBytes).catch(() => undefined);
  const ordinal = lines === undefined ? undefined : maxOrdinalFromRecords(lines);
  return ordinal === undefined ? undefined : { rollout: selected.file, ordinal };
}
