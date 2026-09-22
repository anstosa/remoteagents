// The pure core of the Code panel: turning a Comparison's per-file patches into `@pierre/diffs`
// CodeView items. Importing the library here (not in comparison.ts) is what keeps it out of the
// eager bundle — only code-panel.tsx, which main.tsx lazy-imports, pulls this in. Kept side-effect
// free so the isolated-component fixture can exercise item derivation without the dashboard.
import { parseDiffFromFile, parsePatchFiles, type CodeViewDiffItem, type CodeViewFileItem, type FileDiffLoadedChangedFiles } from '@pierre/diffs';
import type { ComparisonFile, ComparisonFileContents } from './comparison.js';

// Line cap for syntax tokenization: past this a file renders as plain (un-highlighted) text so a
// very large diff or file never blocks the main thread. From the spike's timing measurements.
export const CODE_TOKENIZE_MAX_LINES = 2000;

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

// Which files can render as a real diff. `binary` / `metadata` files carry a human note rather than
// a unified patch, and a `capped` file has its patch withheld — all of those become placeholders.
export const isDiffable = (file: ComparisonFile): boolean => !file.capped && (file.kind === 'tracked' || file.kind === 'untracked');

// Build a diff item for one non-capped file from its captured patch. Returns undefined when the
// text is not a diff the parser can recover (e.g. a git binary patch), so the caller shows a
// placeholder instead. The item id is content-stable (`diff:<path>`) so controlled reconciliation
// matches it across updates and every line stays addressable as (path, side, line).
export const diffItemForFile = (file: ComparisonFile): CodeViewDiffItem | undefined => {
  if (!isDiffable(file)) return undefined;
  const version = contentHash(file.patch);
  const parsed = parsePatchFiles(file.patch, `${file.change.path}#${version}`, false);
  const fileDiff = parsed.flatMap(patch => patch.files)[0];
  if (fileDiff === undefined) return undefined;
  return { id: `diff:${file.change.path}`, type: 'diff', fileDiff, version };
};

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
