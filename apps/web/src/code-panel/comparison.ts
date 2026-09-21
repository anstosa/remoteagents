// The Code panel's data layer, kept free of any `@pierre/diffs` import so it stays in the eager
// bundle: the heavy diff library lives only in `code-panel.tsx`, which main.tsx lazy-imports. This
// module owns the wire shapes of the two Comparison endpoints, the Implementation/Tests-&-docs
// classifier, and the `useCodePanel` controller that opens the panel and fetches a Comparison.
import { useCallback, useEffect, useRef, useState } from 'react';

// The two Comparisons a Worktree can show, matching the server's `ComparisonKind`.
export type CodePanelMode = 'working' | 'pr';

// One changed path in a Comparison — the client mirror of the server `GitStatusChange`.
export type ComparisonChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation' | 'test' | 'doc' };
// How a file's patch was produced; mirrors the server `ComparisonFileKind`.
export type ComparisonFileKind = 'tracked' | 'metadata' | 'binary' | 'untracked';
// One file of a Comparison patch: its Change, the captured patch text, and whether the server
// withheld that text for being over a size cap (drives the "Load anyway" placeholder).
export type ComparisonFile = { change: ComparisonChange; kind: ComparisonFileKind; patch: string; capped: boolean };
// The `POST /api/worktrees/:id/comparison` response: every Change with its per-file patch, a
// content-sensitive fingerprint (for staleness), and whether the file-count/total cap truncated it.
export type ComparisonPatch = { kind: CodePanelMode; base: string; gitBase: string; files: ComparisonFile[]; fingerprint: string; truncated: boolean };

// One side of a file in a Comparison, from `POST /api/worktrees/:id/comparison/file`.
export type RevisionFile = { path: string; size: number; binary: boolean; truncated: boolean; content?: string };
// A changed file's two sides; either is null for an add or a delete.
export type ComparisonFileContents = { path: string; base: RevisionFile | null; working: RevisionFile | null };

// The authenticated fetch main.tsx already owns (attaches the CSRF header); injected so this module
// need not reach back into the app entry, and so tests can drive it with a scripted requester.
export type Requester = (url: string, init?: RequestInit) => Promise<Response>;

const isChange = (value: unknown): value is ComparisonChange =>
  value !== null && typeof value === 'object' && typeof (value as ComparisonChange).code === 'string' && typeof (value as ComparisonChange).path === 'string';

const comparisonFileKinds = new Set<ComparisonFileKind>(['tracked', 'metadata', 'binary', 'untracked']);

const isComparisonFile = (value: unknown): value is ComparisonFile =>
  value !== null && typeof value === 'object'
  && isChange((value as ComparisonFile).change)
  && comparisonFileKinds.has((value as ComparisonFile).kind)
  && typeof (value as ComparisonFile).patch === 'string'
  && typeof (value as ComparisonFile).capped === 'boolean';

// Validate the patch endpoint's payload before trusting it, the way `useFilePreview` guards its own.
export const isComparisonPatch = (value: unknown): value is ComparisonPatch =>
  value !== null && typeof value === 'object'
  && ((value as ComparisonPatch).kind === 'working' || (value as ComparisonPatch).kind === 'pr')
  && typeof (value as ComparisonPatch).fingerprint === 'string'
  && Array.isArray((value as ComparisonPatch).files)
  && (value as ComparisonPatch).files.every(isComparisonFile);

const isRevisionFile = (value: unknown): value is RevisionFile =>
  value !== null && typeof value === 'object' && typeof (value as RevisionFile).path === 'string' && typeof (value as RevisionFile).binary === 'boolean'
  && ((value as RevisionFile).content === undefined || typeof (value as RevisionFile).content === 'string');

const isComparisonFileContents = (value: unknown): value is ComparisonFileContents =>
  value !== null && typeof value === 'object'
  && typeof (value as ComparisonFileContents).path === 'string'
  && ((value as ComparisonFileContents).base === null || isRevisionFile((value as ComparisonFileContents).base))
  && ((value as ComparisonFileContents).working === null || isRevisionFile((value as ComparisonFileContents).working));

// Which files read as supporting (tests, specs, docs) rather than implementation. Prefer the
// server-assigned category; fall back to the same path heuristic the GitStatus flyout uses so the
// panel groups a Change identically to the flyout that opened it.
export const supportingChange = (change: ComparisonChange): boolean =>
  change.category === undefined ? supportingPath(change.path) : change.category !== 'implementation';

const supportingPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return /(^|\/)(?:__tests__|e2e|specs?|tests?)(?:\/|$)/u.test(lower)
    || /(?:^|[._-])(?:spec|test)(?:[._-]|$)/u.test(name)
    || /(^|\/)(?:docs?|documentation)(?:\/|$)/u.test(lower)
    || /\.(?:adoc|md|mdx|rst)$/u.test(name)
    || /^(?:changelog|code_of_conduct|contributing|license|readme|security)(?:\.|$)/u.test(name);
};

// A Comparison's files split into the two groups the panel renders: implementation first, the
// supporting group collapsed behind a toggle. Order within each group is the server's order.
export type GroupedFiles = { implementation: ComparisonFile[]; supporting: ComparisonFile[] };
export const groupComparisonFiles = (files: ComparisonFile[]): GroupedFiles => ({
  implementation: files.filter(file => !supportingChange(file.change)),
  supporting: files.filter(file => supportingChange(file.change))
});

// The lifecycle of a Comparison fetch, mirroring `useFilePreview`'s loading/ready/error states.
export type CodePanelState = 'loading' | 'ready' | 'error';

// One Worktree's Code panel: whether it is open, which Comparison it shows, the latest patch, and
// the actions the flyout and the panel drive. Threaded to `Log`/`WorktreeCard` as a single prop.
export type CodePanelController = {
  open: boolean;
  mode: CodePanelMode;
  state: CodePanelState;
  patch: ComparisonPatch | undefined;
  // open (or refocus) the panel on the given Comparison, seeded from the flyout's mode
  openChanges(mode: CodePanelMode): void;
  // re-request the current Comparison (used by the retry affordance)
  refresh(): void;
  // fetch one changed file's two sides, for the "Load anyway" placeholder
  loadFile(path: string): Promise<ComparisonFileContents | undefined>;
  close(): void;
};

// scope the open flag to one browser client and Worktree, mirroring the browser split's key
const codeOpenKey = (worktreeId: string) => `rac.code-open:${worktreeId}`;
const savedCodeOpen = (worktreeId: string | undefined): boolean => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(codeOpenKey(worktreeId)) === '1'; } catch { return false; }
};
const saveCodeOpen = (worktreeId: string | undefined, open: boolean) => {
  if (worktreeId === undefined) return;
  try { if (open) localStorage.setItem(codeOpenKey(worktreeId), '1'); else localStorage.removeItem(codeOpenKey(worktreeId)); }
  catch { /* browser storage is optional */ }
};

// Own one Worktree's Code panel: its open/mode state, and the Comparison fetch that refreshes when
// the Worktree, mode, or an explicit refresh changes. Fetches only while open so a closed panel
// costs nothing; a request-id guard drops replaced or stale responses like `useFilePreview`.
export const useCodePanel = (worktreeId: string | undefined, request: Requester): CodePanelController => {
  const [open, setOpen] = useState(() => savedCodeOpen(worktreeId));
  const [mode, setModeState] = useState<CodePanelMode>('working');
  const [state, setState] = useState<CodePanelState>('loading');
  const [patch, setPatch] = useState<ComparisonPatch>();
  const [refreshToken, setRefreshToken] = useState(0);
  const requestId = useRef(0);

  // a closed or unscoped panel holds no Comparison; reopening refetches from scratch
  useEffect(() => {
    setOpen(savedCodeOpen(worktreeId));
    setPatch(undefined);
    requestId.current += 1;
  }, [worktreeId]);

  useEffect(() => {
    if (!open || worktreeId === undefined) return;
    const id = ++requestId.current;
    setState('loading');
    setPatch(undefined);
    void (async () => {
      try {
        const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/comparison`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: mode }) });
        if (!response.ok) throw new Error('comparison unavailable');
        const payload: unknown = await response.json();
        if (!isComparisonPatch(payload)) throw new Error('invalid comparison');
        // drop a response the panel no longer awaits
        if (requestId.current !== id) return;
        setPatch(payload);
        setState('ready');
      } catch { if (requestId.current === id) setState('error'); }
    })();
  }, [open, worktreeId, mode, refreshToken, request]);

  const openChanges = useCallback((next: CodePanelMode) => {
    setModeState(next);
    setOpen(true);
    saveCodeOpen(worktreeId, true);
  }, [worktreeId]);

  const refresh = useCallback(() => setRefreshToken(token => token + 1), []);
  const close = useCallback(() => { setOpen(false); saveCodeOpen(worktreeId, false); }, [worktreeId]);

  const loadFile = useCallback(async (path: string): Promise<ComparisonFileContents | undefined> => {
    if (worktreeId === undefined) return undefined;
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/comparison/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: mode, path }) });
      if (!response.ok) return undefined;
      const payload: unknown = await response.json();
      return isComparisonFileContents(payload) ? payload : undefined;
    } catch { return undefined; }
  }, [worktreeId, mode, request]);

  return { open: open && worktreeId !== undefined, mode, state, patch, openChanges, refresh, loadFile, close };
};
