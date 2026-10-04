// The jump from a rendered diff or file to that line in the operator's configured editor, shared by
// the Code panel and the Review tour: which working-tree line a diff line stands for, and the file
// header button that opens it. Lives beside the diff renderers (and imports only the library's
// types), so it rides in their lazy chunk.
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';

// Where an editor jump lands: a file relative to the Place folder, and a line in the working tree's
// copy of it.
export type EditorTarget = { file: string; line: number };

// Which side of a diff a line number counts on: the base (deletions) or the change (additions).
export type DiffSide = 'deletions' | 'additions';

// Whether a path can be opened in the editor: relative to the Place folder and unable to climb out
// of it — the same rule the server enforces, so the button is not offered for a path it refuses.
export const isPlaceRelativePath = (path: string): boolean => path !== '' && !path.startsWith('/') && !path.split('/').includes('..');

// The working tree's line for a line of a diff. An added or context line already counts there; a
// removed line no longer exists, so it maps to where it was — the line now standing in its place.
// An old-side line outside every hunk (an expanded unchanged line) shifts by the hunks above it.
export const newSideLine = (fileDiff: FileDiffMetadata, side: DiffSide, line: number): number => {
  if (side === 'additions') return line;
  let shift = 0;
  for (const hunk of fileDiff.hunks) {
    if (line < hunk.deletionStart) break;
    let deletion = hunk.deletionStart;
    let addition = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      const count = content.type === 'context' ? content.lines : content.deletions;
      if (line >= deletion && line < deletion + count) return Math.max(1, content.type === 'context' ? addition + line - deletion : addition);
      deletion += count;
      addition += content.type === 'context' ? content.lines : content.additions;
    }
    shift = addition - deletion;
  }
  return Math.max(1, line + shift);
};

// The working tree's line where a diff's first change sits: its first added line, or for a pure
// removal the line now standing where the removed ones were.
export const firstChangedLine = (fileDiff: FileDiffMetadata): number => {
  const hunk = fileDiff.hunks[0];
  if (hunk === undefined) return 1;
  let addition = hunk.additionStart;
  for (const content of hunk.hunkContent) {
    if (content.type === 'change') break;
    addition += content.lines;
  }
  return Math.max(1, addition);
};

// The working tree's line a diff's selected range starts on, or its first change with nothing
// selected. In a unified diff a range can begin on a removed line and end on an added one; removed
// lines sit above added ones in a hunk, so a cross-side range starts on its deletions end.
export const diffJumpLine = (fileDiff: FileDiffMetadata, range: SelectedLineRange | undefined): number => {
  if (range === undefined) return firstChangedLine(fileDiff);
  const side = range.side ?? range.endSide ?? 'additions';
  const endSide = range.endSide ?? side;
  if (side === endSide) return newSideLine(fileDiff, side, Math.min(range.start, range.end));
  return side === 'deletions' ? newSideLine(fileDiff, side, range.start) : newSideLine(fileDiff, endSide, range.end);
};

// The file header button: opens `file` at `line`, which it shows.
export function EditorJumpButton({ file, line, onOpen }: { file: string; line: number; onOpen: (target: EditorTarget) => void }) {
  const label = `Open ${file} at line ${line} in the editor`;
  return <button type="button" className="editor-jump" aria-label={label} title={label} onClick={() => onOpen({ file, line })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg><span>{line}</span></button>;
}
