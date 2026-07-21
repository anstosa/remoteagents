import { describe, expect, it } from 'vitest';
import { logFrame } from '../src/app.js';

describe('log frame generation', () => {
  it('does not reset the terminal for empty captures', () => {
    expect(logFrame('existing output', '')).toBeUndefined();
    expect(logFrame('existing output', '   \n\t')).toBeUndefined();
  });

  it('appends snapshots that retain the existing output', () => {
    expect(logFrame('one\ntwo', 'one\ntwo\nthree')).toEqual({ type: 'append', text: '\nthree' });
  });

  it('appends after a rolling tmux capture window', () => {
    expect(logFrame('0123456789', '3456789abc')).toEqual({ type: 'append', text: 'abc' });
  });

  it('appends the changed line from a terminal redraw', () => {
    expect(logFrame('first\nworking', 'first\ncomplete')).toEqual({ type: 'append', text: '\ncomplete' });
  });

  it('marks unrelated non-empty snapshots as a reset', () => {
    expect(logFrame('old output', 'new output')).toEqual({ type: 'reset', text: 'new output' });
  });
});
