import { describe, expect, it } from 'vitest';
import { paneEnv, safeEnv } from '../src/tmux/command.js';

// The launch runner is the process tmux starts in a new pane, so its own environment
// carries the pane's `TMUX`/`TMUX_PANE`; the shell it spawns must inherit exactly that
// pair (the reporter hook writes `@rac_*` on `$TMUX_PANE`) and nothing else beyond the
// restricted environment.
describe('paneEnv', () => {
  it('passes the pane naming pair tmux set on the runner through to the pane shell', () => {
    const env = paneEnv({ TMUX: '/tmp/tmux-1000/default,1890011,0', TMUX_PANE: '%39' });
    expect(env.TMUX).toBe('/tmp/tmux-1000/default,1890011,0');
    expect(env.TMUX_PANE).toBe('%39');
  });

  it('keeps the restricted environment otherwise, admitting nothing else from the runner', () => {
    const env = paneEnv({ TMUX_PANE: '%39', RAC_SESSION_SECRET: 'hunter2', PATH: '/elsewhere/bin', HOME: '/elsewhere' });
    expect(env).toEqual({ ...safeEnv(), TMUX_PANE: '%39' });
    expect(env).not.toHaveProperty('RAC_SESSION_SECRET');
  });

  it('omits the pair outside a pane, and ignores empty values', () => {
    expect(paneEnv({})).toEqual(safeEnv());
    expect(paneEnv({ TMUX: '', TMUX_PANE: '' })).toEqual(safeEnv());
  });
});
