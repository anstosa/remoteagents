import { describe, expect, it } from 'vitest';
import { boundedViewport } from '../src/logs/viewport.js';

describe('browser viewport frames', () => {
  it('sizes a grid wider than tmux will be asked for down instead of refusing it', () => {
    // a 4K display fits 537 columns; refusing the frame closed the socket and
    // the browser reconnected with the same grid forever
    expect(boundedViewport({ cols: 537, rows: 87 })).toEqual({ cols: 500, rows: 87 });
    expect(boundedViewport({ cols: 120, rows: 400 })).toEqual({ cols: 120, rows: 300 });
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
