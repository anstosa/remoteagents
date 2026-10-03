// The Review tour's diff renderer: the Changes of one tour step rendered with `@pierre/diffs`, the
// same library and theming the Code panel uses, so a guided review reads with the same fidelity as
// the standalone panel (real syntax highlighting, line numbers, unified or — with room — split
// diffs). It is a second importer of the library, so — like code-panel.tsx — it is only ever reached
// through a dynamic `import()` (review-tour.tsx lazy-loads it); review-tour.tsx itself is in the
// eager dashboard bundle, so importing the library here directly would drag its ~177 kB in. Controlled and side-effect free:
// the caller hands in the step's Changes and this renders them. The only state it owns is visual: the
// Unified / Split choice, which (rendered at the same spot for every step) carries across steps.
import { type CSSProperties, useMemo, useState } from 'react';
import { CodeView, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useColorTheme } from '../color-theme.js';
import { useTerminalFontSize } from '../terminal-font-size.js';
import { DiffLayoutSegment, SPLIT_MIN_WIDTH, useObservedWidth } from './diff-layout.js';
import { codeViewBaseOptions, codeViewStyle, diffItemForPatch } from './items.js';

type ReviewItem = CodeViewItem<undefined>;
type ReviewOptions = CodeViewReactOptions<undefined, undefined>;

// One Change of a tour step: the file it touches (and, for a rename, where it moved from), the kind
// of change, and its captured unified patch. A structural subset of the tour's ReviewChange — the
// kind union is kept intact so the `kind === 'binary'` placeholder note stays typo-checked.
export type ReviewDiffChange = { id: string; file: string; originalFile?: string; kind: 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked'; patch: string };

// render one tour step with current display settings
export default function ReviewDiffs({ changes }: { changes: ReviewDiffChange[] }) {
  const theme = useColorTheme();
  const terminalFontSize = useTerminalFontSize();
  // Each renderable Change becomes one diff item, keyed by its Change id so a file split across
  // several hunks (each its own Change) does not collide on its path. A Change whose patch is not a
  // diff the parser can recover (a binary file, a metadata-only change) falls back to a placeholder.
  const { items, placeholders } = useMemo(() => {
    const items: ReviewItem[] = [];
    const placeholders: ReviewDiffChange[] = [];
    for (const change of changes) {
      const item = diffItemForPatch(change.id, change.patch);
      if (item === undefined) placeholders.push(change); else items.push(item);
    }
    return { items, placeholders };
  }, [changes]);

  // Split follows the Code panel's rule: offered only when the diff pane itself is wide enough, so a
  // phone or a narrow dialog always reads unified.
  const [split, setSplit] = useState(false);
  const [viewRef, viewWidth] = useObservedWidth();
  const splitFits = viewWidth >= SPLIT_MIN_WIDTH;
  const effectiveSplit = split && splitFits;

  // The Code panel's shared render options (the tour has no full-context toggle).
  const options = useMemo<ReviewOptions>(() => ({ ...codeViewBaseOptions(theme === 'latte' ? 'light' : 'dark', terminalFontSize), diffStyle: effectiveSplit ? 'split' : 'unified' }), [effectiveSplit, terminalFontSize, theme]);

  const style = codeViewStyle(terminalFontSize) as CSSProperties;
  return (
    <div className="review-tour-diff-view" style={style} ref={viewRef}>
      {items.length > 0 && splitFits && <div className="review-tour-diff-toolbar"><DiffLayoutSegment split={effectiveSplit} onChange={setSplit} /></div>}
      {placeholders.length > 0 && (
        <ul className="review-tour-diff-placeholders">
          {placeholders.map(change => (
            <li key={change.id}>
              <span className="review-tour-diff-placeholder-path" title={change.file}>{change.originalFile === undefined ? change.file : `${change.originalFile} → ${change.file}`}</span>
              <span className="review-tour-diff-placeholder-note">{change.kind === 'binary' ? 'Binary file' : 'No preview available'}</span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && <CodeView className="review-tour-diff-scroll" options={options} items={items} disableWorkerPool />}
    </div>
  );
}
