import { paneSizeLimit } from '../tmux/adapter.js';

export type BoundedViewport = { cols: number; rows: number };

/**
 * The pane size a browser frame asks for, sized down to the largest pane the
 * console will ask tmux for. A browser grid can legitimately exceed that limit
 * (a 4K display fits 500+ columns), and refusing such a frame closed the log
 * socket, which the browser reopened with the same grid forever. Only a
 * malformed grid is refused.
 */
export function boundedViewport(frame: { cols: unknown; rows: unknown }): BoundedViewport | undefined {
  const { cols, rows } = frame;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (rows as number) < 2) return undefined;
  return { cols: Math.min(cols as number, paneSizeLimit.cols), rows: Math.min(rows as number, paneSizeLimit.rows) };
}
