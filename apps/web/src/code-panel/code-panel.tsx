// The Code panel view: one virtualized scroll of a Comparison's Changes, rendered with
// `@pierre/diffs`. This module is the app's only importer of the library, and main.tsx pulls it in
// with a dynamic `import()` so the ~177 kB (plus lazy shiki chunks) never lands in the eager
// dashboard bundle. It is a controlled view — main.tsx (or the test fixture) owns the Comparison
// and hands it in — so it stays free of any network code and easy to drive in isolation.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { CodeView, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useColorTheme } from '../color-theme.js';
import { groupComparisonFiles, type CodePanelMode, type CodePanelState, type ComparisonFile, type ComparisonFileContents, type ComparisonPatch } from './comparison.js';
import { CODE_TOKENIZE_MAX_LINES, diffItemForContents, diffItemForFile } from './items.js';

type PanelItem = CodeViewItem<undefined>;
type PanelOptions = CodeViewReactOptions<undefined, undefined>;

// The font metrics the diffs render at. Kept as constants so the CSS variables the shadow DOM reads
// and the virtualiser's `itemMetrics` stay in lockstep — a mismatch mis-measures every row's height.
const FONT_SIZE = 13;
const LINE_HEIGHT = 20;

export type CodePanelProps = {
  mode: CodePanelMode;
  state: CodePanelState;
  patch: ComparisonPatch | undefined;
  loadFile: (path: string) => Promise<ComparisonFileContents | undefined>;
  onClose: () => void;
  onRetry?: () => void;
};

// Why a Change shows a placeholder instead of a rendered diff.
type PlaceholderReason = 'capped' | 'binary' | 'metadata' | 'unrenderable';
type Placeholder = { path: string; reason: PlaceholderReason; note?: string };
// The per-Change load status of the "Load anyway" affordance.
type LoadStatus = 'loading' | 'error';

export default function CodePanel({ mode, state, patch, loadFile, onClose, onRetry }: CodePanelProps) {
  const theme = useColorTheme();
  const [supportingExpanded, setSupportingExpanded] = useState(false);
  // Changes the reviewer pulled in with "Load anyway", keyed by path; they render as ordinary diff
  // items alongside the rest.
  const [loaded, setLoaded] = useState<Record<string, PanelItem>>({});
  const [loadStatus, setLoadStatus] = useState<Record<string, LoadStatus>>({});

  // "Load anyway" results belong to one Comparison; drop them when the patch changes (a mode switch
  // or refetch) so a withheld file from the old Comparison never lingers in the new one.
  useEffect(() => { setLoaded({}); setLoadStatus({}); }, [patch?.fingerprint]);
  // The current Comparison's fingerprint, tracked in a ref so an in-flight "Load anyway" can tell
  // the Comparison changed under it (a stale resolve must not write into the new patch's map).
  const fingerprintRef = useRef(patch?.fingerprint);
  fingerprintRef.current = patch?.fingerprint;

  const groups = useMemo(() => patch === undefined ? { implementation: [], supporting: [] } : groupComparisonFiles(patch.files), [patch]);

  // One pass over the visible files, in Implementation-then-Tests&docs order, splitting each into a
  // rendered diff item (in the scroll) or a placeholder (in the list above it). "Load anyway" moves a
  // file out of the placeholder list and into the diff scroll, in its group order.
  const { items, placeholders } = useMemo(() => {
    const ordered: ComparisonFile[] = [...groups.implementation, ...(supportingExpanded ? groups.supporting : [])];
    const nextItems: PanelItem[] = [];
    const nextPlaceholders: Placeholder[] = [];
    for (const file of ordered) {
      const path = file.change.path;
      const already = loaded[path];
      if (already !== undefined) { nextItems.push(already); continue; }
      if (file.capped) { nextPlaceholders.push({ path, reason: 'capped' }); continue; }
      if (file.kind === 'binary') { nextPlaceholders.push({ path, reason: 'binary' }); continue; }
      if (file.kind === 'metadata') { nextPlaceholders.push({ path, reason: 'metadata', note: file.patch }); continue; }
      const item = diffItemForFile(file);
      if (item !== undefined) nextItems.push(item); else nextPlaceholders.push({ path, reason: 'unrenderable' });
    }
    return { items: nextItems, placeholders: nextPlaceholders };
  }, [groups, supportingExpanded, loaded]);

  const options = useMemo<PanelOptions>(() => ({
    theme: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
    themeType: theme === 'latte' ? 'light' : 'dark',
    preferredHighlighter: 'shiki-js',
    // one readable column, no split; the split/unified toggle arrives with the single-file toolbar
    diffStyle: 'unified',
    overflow: 'scroll',
    hunkSeparators: 'line-info',
    stickyHeaders: true,
    enableLineSelection: true,
    // past the cap a file renders as plain text so a huge diff never freezes the tab
    tokenizeMaxLength: CODE_TOKENIZE_MAX_LINES,
    itemMetrics: { lineHeight: LINE_HEIGHT, diffHeaderHeight: LINE_HEIGHT + 24 }
  }), [theme]);

  // Pull a withheld or binary Change in on demand: fetch its two sides and diff them in the browser.
  const loadAnyway = async (path: string) => {
    const fingerprint = patch?.fingerprint;
    setLoadStatus(current => ({ ...current, [path]: 'loading' }));
    const contents = await loadFile(path);
    // drop a result whose Comparison has since changed — the fingerprint effect already cleared state
    if (fingerprintRef.current !== fingerprint) return;
    const item = contents === undefined ? undefined : diffItemForContents(contents);
    if (item === undefined) { setLoadStatus(current => ({ ...current, [path]: 'error' })); return; }
    setLoaded(current => ({ ...current, [path]: item }));
    setLoadStatus(current => { const next = { ...current }; delete next[path]; return next; });
  };

  const fileCount = groups.implementation.length + groups.supporting.length;
  const title = mode === 'working' ? 'Working changes' : 'All PR changes';
  const style = { '--diffs-font-size': `${FONT_SIZE}px`, '--diffs-line-height': `${LINE_HEIGHT}px` } as CSSProperties;

  return (
    <section className="code-pane" style={style} role="region" aria-label="Code changes">
      <header className="code-pane-toolbar">
        <strong className="code-pane-title">{title}</strong>
        {state === 'ready' && <span className="code-pane-count">{fileCount === 1 ? '1 file' : `${fileCount} files`}</span>}
        {state === 'ready' && groups.supporting.length > 0 && (
          <button type="button" className="code-pane-group-toggle" aria-pressed={supportingExpanded} onClick={() => setSupportingExpanded(value => !value)}>
            {supportingExpanded ? 'Hide' : 'Show'} tests &amp; docs ({groups.supporting.length})
          </button>
        )}
        <button type="button" className="code-pane-close" aria-label="Close code changes" title="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="code-pane-body">
        {state === 'loading' && <p className="code-pane-status">Loading changes…</p>}
        {state === 'error' && <p className="code-pane-status" role="alert">Unable to load changes.{onRetry !== undefined && <> <button type="button" className="code-pane-retry" onClick={onRetry}>Retry</button></>}</p>}
        {state === 'ready' && fileCount === 0 && <p className="code-pane-status">No changes to show.</p>}
        {state === 'ready' && fileCount > 0 && <>
          {patch?.truncated === true && <p className="code-pane-notice">Some files were left out because the change set is very large.</p>}
          {placeholders.length > 0 && (
            <ul className="code-pane-placeholders">
              {placeholders.map(placeholder => (
                <li key={placeholder.path} className={`code-pane-placeholder ${placeholder.reason}`}>
                  <span className="code-pane-placeholder-path" title={placeholder.path}>{placeholder.path}</span>
                  <span className="code-pane-placeholder-note">
                    {placeholder.reason === 'capped' && 'File too large to preview'}
                    {placeholder.reason === 'binary' && 'Binary file'}
                    {placeholder.reason === 'metadata' && (placeholder.note ?? 'Not a regular file')}
                    {placeholder.reason === 'unrenderable' && 'Diff unavailable'}
                  </span>
                  {(placeholder.reason === 'capped' || placeholder.reason === 'unrenderable') && (
                    loadStatus[placeholder.path] === 'error'
                      ? <span className="code-pane-placeholder-error">Could not load</span>
                      : <button type="button" className="code-pane-load" disabled={loadStatus[placeholder.path] === 'loading'} onClick={() => void loadAnyway(placeholder.path)}>{loadStatus[placeholder.path] === 'loading' ? 'Loading…' : 'Load anyway'}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <CodeView className="code-pane-view" options={options} items={items} disableWorkerPool />
        </>}
      </div>
    </section>
  );
}
