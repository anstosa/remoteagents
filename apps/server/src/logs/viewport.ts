import { paneSizeLimit } from '../tmux/adapter.js';

export type BoundedViewport = { cols: number; rows: number };

/**
 * The pane size a browser frame asks for, sized down only to tmux's own maximum
 * window dimension (`paneSizeLimit`, 10000). The console imposes no smaller ceiling
 * (Sizing, ADR 0008: the old 500x300 clamp is gone), so a wide 4K grid is honoured.
 * Clamping rather than refusing an out-of-range grid matters because refusing one
 * closed the log socket, which the browser reopened with the same grid forever. Only
 * a malformed grid is refused.
 */
export function boundedViewport(frame: { cols: unknown; rows: unknown }): BoundedViewport | undefined {
  const { cols, rows } = frame;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (rows as number) < 2) return undefined;
  return { cols: Math.min(cols as number, paneSizeLimit.cols), rows: Math.min(rows as number, paneSizeLimit.rows) };
}
