import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';

// The files a Stack process reports to the console through, beside its log: its Process notices
// and the processes it uses in other Worktrees. Each is a JSON array the process writes whole, held
// to the same limits: bigger is ignored whole, and only its first entries are read.
export const maxReportFileBytes = 64 * 1024;
export const maxReportEntries = 20;
const overLimit = `it is over ${maxReportFileBytes / 1024} KB`;

// A report file's text as its entries: a JSON array, of which only the first `maxReportEntries` are
// read, each matching `entry`. Anything else is `invalid`, with why, and ignored whole: a wrapper
// that writes a half-broken file shows nothing rather than part of it. Why names where the file
// went wrong, calling an entry a `noun`, but never repeats what it holds, which goes to the
// console's log.
export function parseReportEntries<T>(text: string, entry: z.ZodType<T, z.ZodTypeDef, unknown>, noun: string): T[] | { invalid: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { invalid: 'it is not JSON' }; }
  if (!Array.isArray(value)) return { invalid: 'it is not a JSON array' };
  const parsed = entry.array().safeParse(value.slice(0, maxReportEntries));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { invalid: `${noun} ${issue?.path.join('.') ?? ''} is ${issue === undefined ? 'invalid' : issue.code === 'custom' ? issue.message : issue.code}` };
  }
  return parsed.data;
}

// what was last read from one file, and the change it was read at
type ReadFile<T> = { change: string; entries: T[] };

// One kind of report file, each read again only when it changes: the dashboard rebuilds about once
// a second, and a file changes only when its process writes it. `parse` reads a file's text; the
// checkout an entry names in `worktree` is then resolved by realpath where the console can see it,
// and one that cannot be resolved is kept as written, tidied of `..` and trailing `/`.
export class ProcessReportFiles<T extends { worktree?: string }> {
  private readonly files = new Map<string, ReadFile<T>>();
  // a file's read still under way, which a concurrent reader joins rather than repeating
  private readonly reading = new Map<string, Promise<T[]>>();

  constructor(private readonly parse: (text: string) => T[] | { invalid: string }) {}

  // The entries in `file`, as the console sees it; none when it is not there. A file that is
  // not a regular file of its own (a symlink, a FIFO), is over the size limit, cannot be read, or
  // does not parse is ignored whole, and `ignored` is told why once per change of it — of the
  // entry itself, so a symlink is not reread as whatever it points at changes.
  read(file: string, ignored: (reason: string) => void): Promise<T[]> {
    const pending = this.reading.get(file);
    if (pending !== undefined) return pending;
    const read = this.readChanged(file, ignored).finally(() => this.reading.delete(file));
    this.reading.set(file, read);
    return read;
  }

  private async readChanged(file: string, ignored: (reason: string) => void): Promise<T[]> {
    const details = await lstat(file, { bigint: true }).catch(() => undefined);
    if (details === undefined) { this.files.delete(file); return []; }
    const change = `${details.ino}:${details.mtimeNs}:${details.size}`;
    const cached = this.files.get(file);
    if (cached?.change === change) return cached.entries;
    const read = await this.readNew(file).catch((error: unknown) => ({ invalid: `it could not be read (${error instanceof Error ? error.message : String(error)})` }));
    if ('invalid' in read) ignored(read.invalid);
    const entries = 'invalid' in read ? [] : read;
    this.files.set(file, { change, entries });
    return entries;
  }

  // read and parse a file that changed; a symlink is refused rather than followed, and a FIFO
  // is opened without blocking and then refused, since neither is a file a process wrote
  private async readNew(file: string): Promise<T[] | { invalid: string }> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (handle instanceof Error) return { invalid: `it could not be opened (${handle.message})` };
    try {
      const details = await handle.stat();
      if (!details.isFile()) return { invalid: 'it is not a regular file' };
      if (details.size > maxReportFileBytes) return { invalid: overLimit };
      const buffer = Buffer.alloc(maxReportFileBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // a file still growing past the limit as it is read is over it too
      if (bytesRead > maxReportFileBytes) return { invalid: overLimit };
      const parsed = this.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if ('invalid' in parsed) return parsed;
      return await Promise.all(parsed.map(async entry => entry.worktree === undefined ? entry : { ...entry, worktree: await realpath(entry.worktree).catch(() => resolve(entry.worktree!)) }));
    } finally { await handle.close(); }
  }
}
