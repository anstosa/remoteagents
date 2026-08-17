import { describe, expect, it } from 'vitest';
import { logFrame } from '../src/app.js';

describe('log frame generation', () => {
  it('does not reset the terminal for empty captures', () => {
    expect(logFrame('existing output', '')).toBeUndefined();
    expect(logFrame('existing output', '   \n\t')).toBeUndefined();
  });

  it('replaces snapshots that retain the existing output', () => {
    expect(logFrame('one\ntwo', 'one\ntwo\nthree')).toEqual({ type: 'reset', text: 'one\ntwo\nthree' });
  });

  it('replaces a rolling tmux capture window as one complete frame', () => {
    expect(logFrame('0123456789', '3456789abc')).toEqual({ type: 'reset', text: '3456789abc' });
  });

  it('resets when a terminal redraw changes already-rendered content', () => {
    expect(logFrame('first\nworking', 'first\ncomplete')).toEqual({ type: 'reset', text: 'first\ncomplete' });
  });

  it('marks unrelated non-empty snapshots as a reset', () => {
    expect(logFrame('old output', 'new output')).toEqual({ type: 'reset', text: 'new output' });
  });

  it('re-emits an unchanged snapshot when metadata refreshes', () => {
    expect(logFrame('same output', 'same output', true)).toEqual({ type: 'reset', text: 'same output' });
    expect(logFrame('', '', true)).toEqual({ type: 'reset', text: '' });
  });
});
