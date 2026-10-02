import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { maxReportFileBytes, parseReportEntries, ProcessReportFiles } from './process-reports.js';

// A Process notice as its Stack process reported it, the checkout it names resolved by realpath
// where the console can see it. Which Worktree that is, and whether the notice shows, is decided
// against the live stack (service.ts).
export type ReportedNotice = { level: 'warning' | 'info'; message: string; worktree?: string; process?: string };

// the limit a notices file is held to, shared with every report file (process-reports.ts)
export const maxNoticeFileBytes = maxReportFileBytes;
const maxMessageLength = 500;

const noticeSchema = z.object({
  level: z.enum(['warning', 'info']).default('warning'),
  message: z.string().min(1).max(maxMessageLength),
  worktree: z.string().refine(isAbsolute, 'worktree must be an absolute path').optional(),
  process: z.string().min(1).optional()
}).refine(notice => notice.process === undefined || notice.worktree !== undefined, 'a process needs its worktree');

// A notices file's text as notices: a JSON array of `{ level?, message, worktree?, process? }`, read
// and refused as every report file is (process-reports.ts).
export function parseProcessNotices(text: string): ReportedNotice[] | { invalid: string } {
  const parsed = parseReportEntries(text, noticeSchema, 'notice');
  if ('invalid' in parsed) return parsed;
  return parsed.map(({ level, message, worktree, process }) => ({ level, message, ...(worktree === undefined ? {} : { worktree }), ...(process === undefined ? {} : { process }) }));
}

// Stack processes' notices files, each read again only when it changes
export class ProcessNoticeFiles extends ProcessReportFiles<ReportedNotice> {
  constructor() { super(parseProcessNotices); }
}
