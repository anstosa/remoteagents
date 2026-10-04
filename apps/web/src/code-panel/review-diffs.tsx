// The Review tour's diff renderer: the Changes of one tour step rendered with `@pierre/diffs`, the
// same library and theming the Code panel uses, so a guided review reads with the same fidelity as
// the standalone panel (real syntax highlighting, line numbers, unified or — with room — split
// diffs). It is a second importer of the library, so — like code-panel.tsx — it is only ever reached
// through a dynamic `import()` (review-tour.tsx lazy-loads it); review-tour.tsx itself is in the
// eager dashboard bundle, so importing the library here directly would drag its ~177 kB in. Controlled:
// the caller hands in the step's Changes and its inline comments, and this renders them, reporting
// comment edits back — including which comments are open, which the caller holds so Escape can close
// them from anywhere in the dialog. The only state it owns is visual: the Unified / Split choice,
// which (rendered at the same spot for every step) carries across steps.
import { type CSSProperties, useMemo, useState } from 'react';
import type { CodeViewLineSelection, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useColorTheme } from '../color-theme.js';
import { useTerminalFontSize } from '../terminal-font-size.js';
import { DiffLayoutSegment, SPLIT_MIN_WIDTH, useObservedWidth } from './diff-layout.js';
import { diffJumpLine, EditorJumpButton, type EditorTarget } from './editor-jump.js';
import { codeViewBaseOptions, codeViewStyle, contentHash, diffItemForPatch } from './items.js';

type CommentAnchor = { commentId: string };
type ReviewItem = CodeViewItem<CommentAnchor>;
type ReviewOptions = CodeViewReactOptions<CommentAnchor, undefined>;

// One Change of a tour step: the file it touches (and, for a rename, where it moved from), the kind
// of change, and its captured unified patch. A structural subset of the tour's ReviewChange — the
// kind union is kept intact so the `kind === 'binary'` placeholder note stays typo-checked.
export type ReviewDiffChange = { id: string; file: string; originalFile?: string; kind: 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked'; patch: string };

// Which side of a diff a line number counts on: the base (deletions) or the change (additions).
export type ReviewDiffSide = 'deletions' | 'additions';

// An inline comment on a line range of one Change. The range runs from (startSide, startLine) to
// (endSide, endLine) — in a unified diff a range can begin on a removed line and end on an added
// one — and the comment renders under its last line.
export type ReviewDiffComment = { id: string; changeId: string; startSide: ReviewDiffSide; startLine: number; endSide: ReviewDiffSide; endLine: number; body: string };

// The longest one inline comment may grow; the caller enforces the shared aggregate cap on top.
export const MAX_INLINE_COMMENT = 4_000;

type ReviewDiffsProps = {
  changes: ReviewDiffChange[];
  comments: ReviewDiffComment[];
  // the comments showing their editor: each new one, and saved ones reopened with Edit
  openCommentIds: ReadonlySet<string>;
  // add a comment, already open
  onCommentAdd: (comment: ReviewDiffComment) => void;
  onCommentChange: (id: string, body: string) => void;
  onCommentOpen: (id: string) => void;
  // close an editor (Done), which discards a comment left empty
  onCommentClose: (id: string) => void;
  onCommentDelete: (id: string) => void;
  // open a file at a line in the configured editor; the header button is hidden without it
  onOpenInEditor?: (target: EditorTarget) => void;
};

// A human label for a comment's line range, e.g. "Line 12", "Lines 12–14", "Lines old 9 – new 11".
export const commentRangeLabel = (comment: Pick<ReviewDiffComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'>): string => {
  if (comment.startSide !== comment.endSide) return `Lines old ${comment.startLine} – new ${comment.endLine}`;
  return comment.startLine === comment.endLine ? `Line ${comment.startLine}` : `Lines ${comment.startLine}–${comment.endLine}`;
};

// Order a picked range top-to-bottom. Within one side line numbers order it; across sides (unified
// view only) removed lines sit above added ones in a hunk, so deletions start the range.
const orderedRange = (range: SelectedLineRange): Pick<ReviewDiffComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'> => {
  const startSide = range.side ?? range.endSide ?? 'additions';
  const endSide = range.endSide ?? startSide;
  if (startSide === endSide) return { startSide, startLine: Math.min(range.start, range.end), endSide, endLine: Math.max(range.start, range.end) };
  return startSide === 'deletions' ? { startSide, startLine: range.start, endSide, endLine: range.end } : { startSide: endSide, startLine: range.end, endSide: startSide, endLine: range.start };
};

// One inline comment: an editor while it is new or reopened, and the saved text otherwise.
function InlineComment({ comment, editing, onEdit, onChange, onDone, onDelete }: { comment: ReviewDiffComment; editing: boolean; onEdit: () => void; onChange: (body: string) => void; onDone: () => void; onDelete: () => void }) {
  const label = commentRangeLabel(comment);
  return (
    <div className="review-tour-inline-comment">
      <small>{label}</small>
      {editing
        ? <>
          <textarea aria-label={`Comment on ${label.toLowerCase()}`} value={comment.body} maxLength={MAX_INLINE_COMMENT} autoFocus onChange={event => onChange(event.target.value)} />
          {comment.body.length >= MAX_INLINE_COMMENT && <span role="status">{MAX_INLINE_COMMENT.toLocaleString()} character limit reached</span>}
          <div><button type="button" onClick={onDelete}>Delete</button><button type="button" onClick={onDone}>Done</button></div>
        </>
        : <>
          <p>{comment.body}</p>
          <div><button type="button" onClick={onDelete}>Delete</button><button type="button" onClick={onEdit}>Edit</button></div>
        </>}
    </div>
  );
}

// render one tour step with current display settings
export default function ReviewDiffs({ changes, comments, openCommentIds, onCommentAdd, onCommentChange, onCommentOpen, onCommentClose, onCommentDelete, onOpenInEditor }: ReviewDiffsProps) {
  const theme = useColorTheme();
  const terminalFontSize = useTerminalFontSize();
  // Each renderable Change becomes one diff item, keyed by its Change id so a file split across
  // several hunks (each its own Change) does not collide on its path. A Change whose patch is not a
  // diff the parser can recover (a binary file, a metadata-only change) falls back to a placeholder.
  const { baseItems, placeholders } = useMemo(() => {
    const baseItems = new Map<string, NonNullable<ReturnType<typeof diffItemForPatch>>>();
    const placeholders: ReviewDiffChange[] = [];
    for (const change of changes) {
      const item = diffItemForPatch(change.id, change.patch);
      if (item === undefined) placeholders.push(change); else baseItems.set(change.id, item);
    }
    return { baseItems, placeholders };
  }, [changes]);

  // Each comment anchors one annotation under its last line. CodeView only re-reads an item when its
  // version moves, so an item's version folds in where its comments sit — and only that, so typing
  // into a comment (which changes no anchor) never re-lays out the diff.
  const anchorKey = comments.map(comment => `${comment.id}@${comment.changeId}:${comment.endSide}:${comment.endLine}`).join('|');
  const items = useMemo(() => [...baseItems].map(([changeId, item]): ReviewItem => {
    const annotations: DiffLineAnnotation<CommentAnchor>[] = comments.filter(comment => comment.changeId === changeId).map(comment => ({ side: comment.endSide, lineNumber: comment.endLine, metadata: { commentId: comment.id } }));
    if (annotations.length === 0) return item as ReviewItem;
    return { ...item, annotations, version: contentHash(`${item.version}|${annotations.map(annotation => `${annotation.metadata.commentId}:${annotation.side}:${annotation.lineNumber}`).join('|')}`) };
  }), [baseItems, anchorKey]); // anchorKey stands in for `comments`: it covers every field read here
  const changeIdByItemId = useMemo(() => new Map([...baseItems].map(([changeId, item]) => [item.id, changeId])), [baseItems]);
  const fileByChangeId = useMemo(() => new Map(changes.map(change => [change.id, change.file])), [changes]);

  // The selected line range, held here so starting a comment can clear it: while a range is selected
  // the library pins the "+" to it, so a stale selection would steal the next comment's placement.
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);

  // Split follows the Code panel's rule: offered only when the diff pane itself is wide enough, so a
  // phone or a narrow dialog always reads unified.
  const [split, setSplit] = useState(false);
  const [viewRef, viewWidth] = useObservedWidth();
  const splitFits = viewWidth >= SPLIT_MIN_WIDTH;
  const effectiveSplit = split && splitFits;

  // The Code panel's shared render options (the tour has no full-context toggle), plus the gutter "+"
  // that starts a comment. On a mouse it shows on hover; on touch, tapping a line number reveals it.
  // Clicking it — after optionally selecting a range of lines — reports the range to comment on.
  const options = useMemo<ReviewOptions>(() => ({
    ...codeViewBaseOptions(theme === 'latte' ? 'light' : 'dark', terminalFontSize),
    diffStyle: effectiveSplit ? 'split' : 'unified',
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange, context: { item: { id: string } }) => {
      const changeId = changeIdByItemId.get(context.item.id);
      if (changeId === undefined) return;
      onCommentAdd({ id: crypto.randomUUID(), changeId, ...orderedRange(range), body: '' });
      // the library commits the picked range as the selection after this callback returns
      window.setTimeout(() => setSelection(null), 0);
    }
  }), [changeIdByItemId, effectiveSplit, onCommentAdd, terminalFontSize, theme]);

  const commentsById = useMemo(() => new Map(comments.map(comment => [comment.id, comment])), [comments]);
  const renderAnnotation = (annotation: { metadata?: CommentAnchor }) => {
    const comment = annotation.metadata === undefined ? undefined : commentsById.get(annotation.metadata.commentId);
    if (comment === undefined) return null;
    return <InlineComment comment={comment} editing={openCommentIds.has(comment.id)} onEdit={() => onCommentOpen(comment.id)} onChange={body => onCommentChange(comment.id, body)} onDone={() => onCommentClose(comment.id)} onDelete={() => onCommentDelete(comment.id)} />;
  };

  // Each file header's editor button opens the working tree's copy at the selected line when one is
  // selected in that diff (clicking a line number selects it), else at the diff's first change. A
  // deleted file has no copy to open.
  const renderHeaderMetadata = (item: ReviewItem) => {
    if (onOpenInEditor === undefined || item.type !== 'diff' || item.fileDiff.type === 'deleted') return null;
    const changeId = changeIdByItemId.get(item.id);
    const file = changeId === undefined ? undefined : fileByChangeId.get(changeId);
    if (file === undefined) return null;
    return <EditorJumpButton file={file} line={diffJumpLine(item.fileDiff, selection?.id === item.id ? selection.range : undefined)} onOpen={onOpenInEditor} />;
  };

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
      {items.length > 0 && <CodeView className="review-tour-diff-scroll" options={options} items={items} renderAnnotation={renderAnnotation} {...(onOpenInEditor === undefined ? {} : { renderHeaderMetadata })} selectedLines={selection} onSelectedLinesChange={setSelection} disableWorkerPool />}
    </div>
  );
}
