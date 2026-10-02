import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseReportEntries, ProcessReportFiles } from './process-reports.js';

// A process in another Worktree that a Stack process reported it uses: the checkout it runs in,
// resolved by realpath where the console can see it, and its process name there. Which Worktree
// that is, and the process's state, is decided against the live stack (service.ts).
export type ReportedUse = { worktree: string; process: string };

// A process is named as the config names one, and a checkout path is held to what a path can be,
// so an entry the console cannot place, which it shows as written, stays small
const useSchema = z.object({
  worktree: z.string().max(4096).refine(isAbsolute, 'worktree must be an absolute path'),
  process: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u, 'process names are letters, digits, `_` and `-`')
});

// A uses file's text as the processes it names: a JSON array of `{ worktree, process }`, read and
// refused as every report file is (process-reports.ts).
export function parseProcessUses(text: string): ReportedUse[] | { invalid: string } {
  const parsed = parseReportEntries(text, useSchema, 'use');
  if ('invalid' in parsed) return parsed;
  return parsed.map(({ worktree, process }) => ({ worktree, process }));
}

// Stack processes' uses files, each read again only when it changes
export class ProcessUseFiles extends ProcessReportFiles<ReportedUse> {
  constructor() { super(parseProcessUses); }
}
