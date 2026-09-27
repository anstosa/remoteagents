import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

// A Process notice as its Stack process reported it, the checkout it names resolved by realpath
// where the console can see it. Which Worktree that is, and whether the notice shows, is decided
// against the live stack (service.ts).
export type ReportedNotice = { level: 'warning' | 'info'; message: string; worktree?: string; process?: string };

// the limits a notices file is held to: bigger is ignored whole, and only its first notices are read
export const maxNoticeFileBytes = 64 * 1024;
const maxNotices = 20;
const maxMessageLength = 500;
const overLimit = `it is over ${maxNoticeFileBytes / 1024} KB`;

const noticeSchema = z.object({
  level: z.enum(['warning', 'info']).default('warning'),
  message: z.string().min(1).max(maxMessageLength),
  worktree: z.string().refine(isAbsolute, 'worktree must be an absolute path').optional(),
  process: z.string().min(1).optional()
}).refine(notice => notice.process === undefined || notice.worktree !== undefined, 'a process needs its worktree');

// A notices file's text as notices: a JSON array of `{ level?, message, worktree?, process? }`, of
// which only the first `maxNotices` are read. Anything else is `invalid`, with why, and ignored
// whole: a wrapper that writes a half-broken file shows nothing rather than part of it. Why names
// where the file went wrong but never repeats what it holds, which goes to the console's log.
export function parseProcessNotices(text: string): ReportedNotice[] | { invalid: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { invalid: 'it is not JSON' }; }
  if (!Array.isArray(value)) return { invalid: 'it is not a JSON array' };
  const parsed = z.array(noticeSchema).safeParse(value.slice(0, maxNotices));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { invalid: `notice ${issue?.path.join('.') ?? ''} is ${issue === undefined ? 'invalid' : issue.code === 'custom' ? issue.message : issue.code}` };
  }
  return parsed.data.map(({ level, message, worktree, process }) => ({ level, message, ...(worktree === undefined ? {} : { worktree }), ...(process === undefined ? {} : { process }) }));
}

// what was last read from one file, and the change it was read at
type ReadFile = { change: string; notices: ReportedNotice[] };

// Stack processes' notices files, each read again only when it changes: the dashboard rebuilds
// about once a second, and a file's notices change only when its process writes it.
export class ProcessNoticeFiles {
  private readonly files = new Map<string, ReadFile>();
  // a file's read still under way, which a concurrent reader joins rather than repeating
  private readonly reading = new Map<string, Promise<ReportedNotice[]>>();

  // The notices in `file`, as the console sees it; none when it is not there. A file that is
  // not a regular file of its own (a symlink, a FIFO), is over the size limit, cannot be read, or
  // does not parse is ignored whole, and `ignored` is told why once per change of it — of the
  // entry itself, so a symlink is not reread as whatever it points at changes.
  read(file: string, ignored: (reason: string) => void): Promise<ReportedNotice[]> {
    const pending = this.reading.get(file);
    if (pending !== undefined) return pending;
    const read = this.readChanged(file, ignored).finally(() => this.reading.delete(file));
    this.reading.set(file, read);
    return read;
  }

  private async readChanged(file: string, ignored: (reason: string) => void): Promise<ReportedNotice[]> {
    const details = await lstat(file, { bigint: true }).catch(() => undefined);
    if (details === undefined) { this.files.delete(file); return []; }
    const change = `${details.ino}:${details.mtimeNs}:${details.size}`;
    const cached = this.files.get(file);
    if (cached?.change === change) return cached.notices;
    const read = await this.readNew(file).catch((error: unknown) => ({ invalid: `it could not be read (${error instanceof Error ? error.message : String(error)})` }));
    if ('invalid' in read) ignored(read.invalid);
    const notices = 'invalid' in read ? [] : read;
    this.files.set(file, { change, notices });
    return notices;
  }

  // read and parse a file that changed; a symlink is refused rather than followed, and a FIFO
  // is opened without blocking and then refused, since neither is a file a process wrote. A
  // checkout path that cannot be resolved is kept as written, tidied of `..` and trailing `/`.
  private async readNew(file: string): Promise<ReportedNotice[] | { invalid: string }> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (handle instanceof Error) return { invalid: `it could not be opened (${handle.message})` };
    try {
      const details = await handle.stat();
      if (!details.isFile()) return { invalid: 'it is not a regular file' };
      if (details.size > maxNoticeFileBytes) return { invalid: overLimit };
      const buffer = Buffer.alloc(maxNoticeFileBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // a file still growing past the limit as it is read is over it too
      if (bytesRead > maxNoticeFileBytes) return { invalid: overLimit };
      const parsed = parseProcessNotices(buffer.subarray(0, bytesRead).toString('utf8'));
      if ('invalid' in parsed) return parsed;
      return await Promise.all(parsed.map(async notice => notice.worktree === undefined ? notice : { ...notice, worktree: await realpath(notice.worktree).catch(() => resolve(notice.worktree!)) }));
    } finally { await handle.close(); }
  }
}
