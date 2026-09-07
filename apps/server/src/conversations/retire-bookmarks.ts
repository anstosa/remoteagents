import { readFile, rename } from 'node:fs/promises';

// resolve the retired bookmarks file: its own environment override, else the legacy default
const bookmarksFile = (env: NodeJS.ProcessEnv): string => env.RAC_BOOKMARKS_FILE ?? '.data/bookmarks.json';

// one field of a boot-log line: strip control/format characters and collapse whitespace so a
// hand-edited or prompt-derived title cannot inject a newline (which would split one bookmark
// across lines) or a terminal escape into the log, then clamp the length (mirrors the adapters'
// title bound). Kept deliberately conservative — the boot log is read in a terminal.
const logField = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);

// one line describing a stored bookmark for the boot log: its Adapter kind (absent = codex, the
// original default), the Conversation id it resumed, and the human title — enough to find the
// Conversation again in the agent's own picker. Malformed fields degrade to a placeholder.
function describe(record: unknown): string {
  const bookmark = (record !== null && typeof record === 'object' ? record : {}) as { threadId?: unknown; title?: unknown; kind?: unknown };
  const kind = typeof bookmark.kind === 'string' ? logField(bookmark.kind) : 'codex';
  const id = typeof bookmark.threadId === 'string' ? logField(bookmark.threadId) : '(unknown id)';
  const title = typeof bookmark.title === 'string' ? logField(bookmark.title) : '(untitled)';
  return `  bookmark ${kind} ${id} ${title}`;
}

// the boot-log lines for a bookmarks file: one per bookmark across every save-key group. A file
// that parses to something other than a bookmarks object degrades to a single warning line so the
// file is still set aside rather than blocking boot.
function describeBookmarks(serialized: string, file: string): string[] {
  const lines: string[] = [];
  try {
    const raw: unknown = JSON.parse(serialized);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const group of Object.values(raw as Record<string, unknown>)) {
        if (Array.isArray(group)) for (const record of group) lines.push(describe(record));
      }
    } else lines.push(`  warning: ${file} is not a bookmarks object; set aside unread`);
  } catch {
    lines.push(`  warning: ${file} is not valid JSON; set aside unread`);
  }
  return lines;
}

/**
 * Retire the Bookmark store at boot (ADR 0007): Conversations replace bookmarks, and nothing
 * converts them. When the bookmarks data file exists, set it aside with a `.retired` suffix and
 * log one line per bookmark (kind, id, title) so nothing disappears silently. A missing file is a
 * no-op, so the log fires exactly once — the second boot finds only the `.retired` file, which is
 * never read.
 *
 * This runs unconditionally on every boot (independent of the legacy-config migration, which only
 * runs for a legacy config), and is best-effort: retirement is not essential to running the
 * console, so an unreadable file or a failed rename logs a warning and lets boot continue rather
 * than crashing it. The file is set aside before its bookmarks are logged, so a failed rename
 * never logs the same bookmarks twice on a later retry.
 */
export async function retireBookmarks(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = message => process.stderr.write(message),
): Promise<void> {
  const file = bookmarksFile(env);
  let serialized: string;
  try {
    serialized = await readFile(file, 'utf8');
  } catch (error) {
    // no bookmarks to retire (or already retired): the one-time step is done
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // an unreadable file must not block boot — retirement is best-effort housekeeping
    log(`warning: could not read ${file} to retire it (${(error as Error).message}); leaving it in place\n`);
    return;
  }
  const lines = describeBookmarks(serialized, file);
  // set the file aside first, so the log fires exactly once: only a successful (irreversible)
  // rename logs the bookmarks; a failed rename leaves the file for a later boot and logs nothing
  try {
    await rename(file, `${file}.retired`);
  } catch (error) {
    log(`warning: could not set ${file} aside (${(error as Error).message}); it will be retired on a later boot\n`);
    return;
  }
  log(`Bookmarks are retired; set ${file} aside as ${file}.retired\n`);
  for (const line of lines) log(`${line}\n`);
}
