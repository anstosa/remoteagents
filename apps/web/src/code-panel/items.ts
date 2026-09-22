// The shared core of everything that renders `@pierre/diffs`: turning a Comparison's per-file patches
// into CodeView items, plus the render metrics and base options both diff renderers use. Importing
// the library here (not in comparison.ts) is what keeps it out of the eager bundle — its only two
// importers, code-panel.tsx and code-panel/review-diffs.tsx, are both reached through a dynamic
// `import()`. Kept side-effect free so the isolated-component fixture can exercise item derivation
// without the dashboard.
import { parseDiffFromFile, parsePatchFiles, type CodeViewDiffItem, type CodeViewFileItem, type FileDiffLoadedChangedFiles } from '@pierre/diffs';
import type { ComparisonFile, ComparisonFileContents } from './comparison.js';

// Line cap for syntax tokenization: past this a file renders as plain (un-highlighted) text so a
// very large diff or file never blocks the main thread. From the spike's timing measurements.
export const CODE_TOKENIZE_MAX_LINES = 2000;

// The font metrics the diffs render at, shared by both renderers so they cannot drift: the same
// numbers drive the `--diffs-*` CSS variables the shadow DOM reads AND the virtualiser's itemMetrics,
// and a mismatch mis-measures every row's height (styles.css notes this lockstep explicitly).
export const CODE_FONT_SIZE = 13;
export const CODE_LINE_HEIGHT = 20;

// The CSS custom properties the diff library reads for its font metrics, applied to the element that
// hosts the CodeView. Cast to CSSProperties at the call site (custom properties aren't in its type).
export const codeViewStyle = (): Record<string, string> => ({ '--diffs-font-size': `${CODE_FONT_SIZE}px`, '--diffs-line-height': `${CODE_LINE_HEIGHT}px` });

// The diff-library options both renderers share (theme, highlighter, scroll/sticky behaviour, the
// freeze cap, and the itemMetrics that track the font metrics above). Each renderer spreads this and
// adds its own view-specific keys — diffStyle, and the Code panel's full-context expandUnchanged /
// loadDiffFiles. `themeType` is driven from color-theme.ts. Literals are pinned so the object stays
// assignable to `CodeViewReactOptions` when spread, without importing the React entry here.
export const codeViewBaseOptions = (themeType: 'light' | 'dark') => ({
  theme: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' } as const,
  themeType,
  preferredHighlighter: 'shiki-js' as const,
  overflow: 'scroll' as const,
  hunkSeparators: 'line-info' as const,
  stickyHeaders: true,
  enableLineSelection: true,
  tokenizeMaxLength: CODE_TOKENIZE_MAX_LINES,
  itemMetrics: { lineHeight: CODE_LINE_HEIGHT, diffHeaderHeight: CODE_LINE_HEIGHT + 24 }
});

// A small, stable content hash (djb2, folded to uint32). Drives both an item's `version` — which
// only moves when the file's content moves — and its content-derived `cacheKey` prefix, never an
// index or a constant, so the library's highlight cache stays correct across live updates.
export const contentHash = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return hash >>> 0;
};

// Combine a file's two sides into one hash input; the leading old-side length keeps the boundary
// between them unambiguous, so distinct (old, new) pairs never collide on the split point.
const sidesHash = (oldText: string, newText: string): number => contentHash(`${oldText.length}:${oldText}:${newText}`);

// A changed file's content version, derived from its captured patch text. This is the single source
// of that formula: `diffItemForFile` stamps it on the item's `version`, and the Code panel keys its
// live-update item cache on the same value, so the two cannot drift.
export const fileVersion = (file: ComparisonFile): number => contentHash(file.patch);

// Which files can render as a real diff. `binary` / `metadata` files carry a human note rather than
// a unified patch, and a `capped` file has its patch withheld — all of those become placeholders.
export const isDiffable = (file: ComparisonFile): boolean => !file.capped && (file.kind === 'tracked' || file.kind === 'untracked');

// Build a diff item from a raw unified patch under a stable, content-independent key — a changed
// file's path (Code panel, one item per file) or a Change id (Review tour, one item per change-hunk,
// so a file split across hunks does not collide on its path). Returns undefined when the text is not
// a diff the parser can recover (e.g. a git binary patch), so the caller shows a placeholder instead.
// The item id (`diff:<key>`) is content-stable so controlled reconciliation matches it across updates
// and every line stays addressable as (key, side, line).
export const diffItemForPatch = (key: string, patch: string): CodeViewDiffItem | undefined => {
  const version = contentHash(patch);
  const parsed = parsePatchFiles(patch, `${key}#${version}`, false);
  const fileDiff = parsed.flatMap(entry => entry.files)[0];
  if (fileDiff === undefined) return undefined;
  return { id: `diff:${key}`, type: 'diff', fileDiff, version };
};

// Build a diff item for one non-capped changed file from its captured patch, keyed by its path.
export const diffItemForFile = (file: ComparisonFile): CodeViewDiffItem | undefined =>
  isDiffable(file) ? diffItemForPatch(file.change.path, file.patch) : undefined;

// Build a diff item from a changed file's two sides (the `/comparison/file` payload), used by the
// "Load anyway" affordance. jsdiff produces a non-partial diff — one that already carries both
// revisions — so it renders without a further hydration round-trip.
export const diffItemForContents = (contents: ComparisonFileContents): CodeViewDiffItem | undefined => {
  const oldText = contents.base?.content;
  const newText = contents.working?.content;
  // a side present but binary (no text) cannot be diffed as text
  if ((contents.base !== null && oldText === undefined) || (contents.working !== null && newText === undefined)) return undefined;
  const oldName = contents.base?.path ?? contents.path;
  const version = sidesHash(oldText ?? '', newText ?? '');
  const oldFile = contents.base === null ? null : { name: oldName, contents: oldText ?? '', cacheKey: `old:${contents.path}#${version}` };
  const newFile = contents.working === null ? null : { name: contents.path, contents: newText ?? '', cacheKey: `new:${contents.path}#${version}` };
  const fileDiff = parseDiffFromFile(oldFile, newFile, undefined, false);
  return { id: `diff:${contents.path}`, type: 'diff', fileDiff, version };
};

// Build a plain (non-diff) file item from the working-tree contents, for the single-file "Plain
// file" mode. The id namespace (`file:`) is disjoint from `diff:` so switching a file between diff
// and plain modes swaps the item cleanly, and `version` moves only when the contents change.
export const fileItemForContents = (path: string, contents: string): CodeViewFileItem => {
  const version = contentHash(contents);
  return { id: `file:${path}`, type: 'file', file: { name: path, contents, cacheKey: `file:${path}#${version}` }, version };
};

// Map a changed file's two sides (the /comparison/file payload) into the `loadDiffFiles` result the
// diff library hydrates a partial patch with, so Full-context mode can expand the surrounding lines.
// Returns undefined when either side has no text (a binary side), which cannot be expanded as text.
export const loadedFilesFromContents = (contents: ComparisonFileContents): FileDiffLoadedChangedFiles | undefined => {
  const oldText = contents.base?.content;
  const newText = contents.working?.content;
  if (oldText === undefined || newText === undefined) return undefined;
  const oldName = contents.base?.path ?? contents.path;
  const version = sidesHash(oldText, newText);
  return {
    oldFile: { name: oldName, contents: oldText, cacheKey: `old:${contents.path}#${version}` },
    newFile: { name: contents.path, contents: newText, cacheKey: `new:${contents.path}#${version}` }
  };
};
