import { describe, expect, it } from 'vitest';
import { boundedViewport } from '../src/logs/viewport.js';

describe('browser viewport frames', () => {
  it('honours a wide grid now that the console imposes no ceiling of its own', () => {
    // the old 500x300 clamp is gone (Sizing, ADR 0008); a 4K display's 537 columns and a
    // 600x40 panel pass through, bounded only by tmux's own 10000 maximum
    expect(boundedViewport({ cols: 537, rows: 87 })).toEqual({ cols: 537, rows: 87 });
    expect(boundedViewport({ cols: 600, rows: 40 })).toEqual({ cols: 600, rows: 40 });
    expect(boundedViewport({ cols: 120, rows: 400 })).toEqual({ cols: 120, rows: 400 });
  });

  it('still sizes a grid past tmux\'s own maximum down instead of refusing it', () => {
    // refusing an out-of-range grid closed the socket and the browser reconnected forever
    expect(boundedViewport({ cols: 12_000, rows: 11_000 })).toEqual({ cols: 10_000, rows: 10_000 });
  });

  it('passes an ordinary grid through unchanged', () => {
    expect(boundedViewport({ cols: 220, rows: 60 })).toEqual({ cols: 220, rows: 60 });
  });

  it('rejects a malformed grid', () => {
    expect(boundedViewport({ cols: '120', rows: 36 })).toBeUndefined();
    expect(boundedViewport({ cols: 120.5, rows: 36 })).toBeUndefined();
    expect(boundedViewport({ cols: 1, rows: 36 })).toBeUndefined();
    expect(boundedViewport({ cols: 120, rows: 0 })).toBeUndefined();
    expect(boundedViewport({ cols: undefined, rows: undefined })).toBeUndefined();
  });
});
